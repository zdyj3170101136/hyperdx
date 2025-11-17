// --------------------------------------------------------
// -------------- EXECUTE EVERY MINUTE --------------------
// --------------------------------------------------------
import * as clickhouse from '@hyperdx/common-utils/dist/clickhouse';
import { getMetadata, Metadata } from '@hyperdx/common-utils/dist/metadata';
import { renderChartConfig } from '@hyperdx/common-utils/dist/renderChartConfig';
import {
  ChartConfigWithOptDateRange,
  DisplayType,
} from '@hyperdx/common-utils/dist/types';
import { formatDate } from '@hyperdx/common-utils/dist/utils';
import * as fns from 'date-fns';
import fnv from 'fnv-plus';
import Handlebars, { HelperOptions } from 'handlebars';
import _ from 'lodash';
import { escapeRegExp, isString } from 'lodash';
import mongoose from 'mongoose';
import ms from 'ms';
import Prometheus from 'prom-client';
import PromisedHandlebars from 'promised-handlebars';
import { serializeError } from 'serialize-error';
import { URLSearchParams } from 'url';

import * as config from '@/config';
import { REAL_FRONTEND_URL } from '@/config';
import { AlertInput } from '@/controllers/alerts';
import { getConnectionById } from '@/controllers/connection';
import { LOCAL_APP_TEAM } from '@/controllers/team';
import Alert, {
  AlertSource,
  AlertState,
  AlertThresholdType,
} from '@/models/alert';
import AlertHistory, { IAlertHistory } from '@/models/alertHistory';
import Dashboard, { IDashboard } from '@/models/dashboard';
import DistributedLock from '@/models/distributedLock';
import { ISavedSearch, SavedSearch } from '@/models/savedSearch';
import { ISource, Source } from '@/models/source';
import { ITeam } from '@/models/team';
import Webhook, { IWebhook } from '@/models/webhook';
import { convertMsToGranularityString, truncateString } from '@/utils/common';
import logger from '@/utils/logger';
import * as slack from '@/utils/slack';

const MAX_MESSAGE_LENGTH = 500;
const NOTIFY_FN_NAME = '__hdx_notify_channel__';
const IS_MATCH_FN_NAME = 'is_match';

// TODO(perf): no need to populate the team
const getAlerts = async () => {
  const alerts = await Alert.find({}).populate<{
    team: ITeam;
  }>(['team']);

  return config.IS_LOCAL_APP_MODE
    ? alerts.map(_alert => {
        // @ts-ignore
        _alert.team = LOCAL_APP_TEAM;
        return _alert;
      })
    : alerts;
};

type EnhancedAlert = Awaited<ReturnType<typeof getAlerts>>[0];

export const buildLogSearchLink = ({
  endTime,
  savedSearch,
  startTime,
}: {
  endTime: Date;
  savedSearch: ISavedSearch;
  startTime: Date;
}) => {
  const url = new URL(`${config.REAL_FRONTEND_URL}/search/${savedSearch.id}`);
  const queryParams = new URLSearchParams({
    from: startTime.getTime().toString(),
    to: endTime.getTime().toString(),
    isLive: 'false',
    // do we need to fill more params here?
  });
  url.search = queryParams.toString();
  return url.toString();
};

// TODO: should link to the chart instead
export const buildChartLink = ({
  dashboardId,
  endTime,
  granularity,
  startTime,
}: {
  dashboardId: string;
  endTime: Date;
  granularity: string;
  startTime: Date;
}) => {
  const url = new URL(`${config.REAL_FRONTEND_URL}/dashboards/${dashboardId}`);
  // extend both start and end time by 7x granularity
  const from = (startTime.getTime() - ms(granularity) * 7).toString();
  const to = (endTime.getTime() + ms(granularity) * 7).toString();
  const queryParams = new URLSearchParams({
    from,
    granularity: convertMsToGranularityString(ms(granularity)),
    to,
  });
  url.search = queryParams.toString();
  return url.toString();
};

export const doesExceedThreshold = (
  thresholdType: AlertThresholdType,
  threshold: number,
  value: number,
) => {
  const isThresholdTypeAbove = thresholdType === AlertThresholdType.ABOVE;
  if (isThresholdTypeAbove && value >= threshold) {
    return true;
  } else if (!isThresholdTypeAbove && value < threshold) {
    return true;
  }
  return false;
};

// transfer keys of attributes with dot into nested object
// ex: { 'a.b': 'c', 'd.e.f': 'g' } -> { a: { b: 'c' }, d: { e: { f: 'g' } } }
export const expandToNestedObject = (
  obj: Record<string, string>,
  separator = '.',
  maxDepth = 10,
) => {
  const result: Record<string, any> = Object.create(null); // An object NOT inheriting from `Object.prototype`
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const keys = key.split(separator);
      let nestedObj = result;

      for (let i = 0; i < keys.length; i++) {
        if (i >= maxDepth) {
          break;
        }
        const nestedKey = keys[i];
        if (i === keys.length - 1) {
          nestedObj[nestedKey] = obj[key];
        } else {
          nestedObj[nestedKey] = nestedObj[nestedKey] || {};
          nestedObj = nestedObj[nestedKey];
        }
      }
    }
  }
  return result;
};

// ------------------------------------------------------------
// ----------------- Alert Message Template -------------------
// ------------------------------------------------------------
// should match the external alert schema
export type AlertMessageTemplateDefaultView = {
  alert: AlertInput;
  attributes: ReturnType<typeof expandToNestedObject>;
  dashboard?: IDashboard | null;
  endTime: Date;
  granularity: string;
  group?: string;
  savedSearch?: ISavedSearch | null;
  source?: ISource | null;
  startTime: Date;
};
export const notifyChannel = async ({
  channel,
  id,
  message,
  team,
  labels,
  orgId,
}: {
  channel: AlertMessageTemplateDefaultView['alert']['channel']['type'];
  id: string;
  message: {
    hdxLink: string;
    title: string;
    query: string;
    sample: string;
    message: string;
    alertname: string;
    alertStartsAt: Date;
    alertEndsAt: Date;
  };
  team: {
    id: string;
  };
  labels: Record<string, string>;
  orgId: string;
}) => {
  switch (channel) {
    case 'webhook': {
      const webhook = await Webhook.findOne({
        team: team.id,
        ...(mongoose.isValidObjectId(id)
          ? { _id: id }
          : {
              name: {
                $regex: new RegExp(`^${escapeRegExp(id)}`), // FIXME: a hacky way to match the prefix
              },
            }),
      });

      if (!webhook) {
        throw new Error('Webhook not found');
      }
      if (webhook?.service === 'alertmanager') {
        await handleSendAlertManagerWebhook(webhook, message, labels, orgId);
      }
      break;
    }
    default:
      throw new Error(`Unsupported channel type: ${channel}`);
  }
};

const handleSendSlackWebhook = async (
  webhook: IWebhook,
  message: {
    hdxLink: string;
    title: string;
    body: string;
  },
) => {
  if (!webhook.url) {
    throw new Error('Webhook URL is not set');
  }

  await slack.postMessageToWebhook(webhook.url, {
    text: message.title,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${message.hdxLink} | ${message.title}>*\n${message.body}`,
        },
      },
    ],
  });
};

import { fetchGrafanaOrgs, type GrafanaOrg } from '@/utils/grafana';

// Cache for all Grafana orgs with TTL (5 minutes)
let cachedOrgs: GrafanaOrg[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get all Grafana orgs with caching (5 minute TTL)
 */
async function getGrafanaOrgsCached(): Promise<GrafanaOrg[]> {
  const now = Date.now();

  // Return cached orgs if still valid
  if (cachedOrgs && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedOrgs;
  }

  // Cache expired or not set, fetch from API
  const orgs = await fetchGrafanaOrgs();

  // Update cache
  cachedOrgs = orgs;
  cacheTimestamp = now;

  return orgs;
}

const handleSendAlertManagerWebhook = async (
  webhook: IWebhook,
  message: {
    hdxLink: string;
    title: string;
    query: string;
    message: string;
    sample: string;
    alertname: string;
    alertStartsAt: Date;
    alertEndsAt: Date;
  },
  labels: Record<string, string>,
  orgId: string,
) => {
  if (!webhook.url) {
    throw new Error('Webhook URL is not set');
  }

  // Fetch Grafana org by orgId from cached orgs list (5 minute TTL)
  let scopeOrgId = '';
  try {
    const orgs = await getGrafanaOrgsCached();
    const grafanaOrg = orgs.find(
      o => o.id.toString() === orgId || o.id === parseInt(orgId, 10),
    );
    if (!grafanaOrg) {
      throw new Error(
        `Grafana org with id ${orgId} not found or could not be fetched`,
      );
    }
    scopeOrgId = grafanaOrg.name;
  } catch (error: any) {
    throw new Error(`Failed to get grafana org: ${error}`);
  }

  // AlertManager 格式的告警信息
  // see https://prometheus.io/docs/alerting/latest/clients/

  // 处理 labels，如果 value 为 "$alertname" 则替换为实际的 alertname
  const processedLabels = Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key,
      value === '$alertname' ? message.alertname : value,
    ]),
  );

  const alertManagerPayload = [
    {
      labels: processedLabels,
      startsAt: message.alertStartsAt.toISOString(),
      endsAt: message.alertEndsAt.toISOString(),
      annotations: {
        message: message.message,
        query: message.query,
        sample: message.sample,
        alertmanager: webhook.name,
        hdx_link: message.hdxLink,
        __orgId__: orgId,
      },
    },
  ];

  console.log(JSON.stringify(alertManagerPayload));
  try {
    // Build headers: X-Scope-OrgID for multi-tenant Grafana AlertManager,
    // using the org.id from Grafana API if available, otherwise use orgId
    // plus any custom headers from webhook config
    const headers = {
      'Content-Type': 'application/json',
      'X-Scope-OrgID': scopeOrgId, // Grafana multi-tenant header (from org.id if found)
    } as Record<string, string>;
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(alertManagerPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `AlertManager webhook failed: ${response.status} ${errorText}`,
      );
    }
  } catch (error: any) {
    throw new Error(`Failed to send AlertManager webhook: ${error}`);
  }
};

export const escapeJsonString = (str: string) => {
  return JSON.stringify(str).slice(1, -1);
};

export const handleSendGenericWebhook = async (
  webhook: IWebhook,
  message: {
    hdxLink: string;
    title: string;
    body: string;
  },
) => {
  // QUERY PARAMS

  if (!webhook.url) {
    throw new Error('Webhook URL is not set');
  }

  let url: string;
  // user input of queryParams is disabled on the frontend for now
  if (webhook.queryParams) {
    // user may have included params in both the url and the query params
    // so they should be merged
    const tmpURL = new URL(webhook.url);
    for (const [key, value] of Object.entries(webhook.queryParams.toJSON())) {
      tmpURL.searchParams.append(key, value);
    }

    url = tmpURL.toString();
  } else {
    // if there are no query params given, just use the url
    url = webhook.url;
  }

  // HEADERS
  // TODO: handle real webhook security and signage after v0
  // X-HyperDX-Signature FROM PRIVATE SHA-256 HMAC, time based nonces, caching functionality etc

  const headers = {
    'Content-Type': 'application/json', // default, will be overwritten if user has set otherwise
    ...(webhook.headers?.toJSON() ?? {}),
  };
  // BODY
  let body = '';
  try {
    const handlebars = Handlebars.create();
    body = handlebars.compile(webhook.body, {
      noEscape: true,
    })({
      body: escapeJsonString(message.body),
      link: escapeJsonString(message.hdxLink),
      title: escapeJsonString(message.title),
    });
  } catch (e) {
    throw new Error(`Failed to compile generic webhook body: ${e}`);
  }

  try {
    // TODO: retries/backoff etc -> switch to request-error-tolerant api client
    const response = await fetch(url, {
      method: 'POST',
      headers: headers as Record<string, string>,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }
  } catch (e) {
    throw new Error(`Failed to send generic webhook message: ${e}`);
  }
};

export const buildAlertMessageTemplateHdxLink = ({
  alert,
  dashboard,
  endTime,
  granularity,
  savedSearch,
  startTime,
}: AlertMessageTemplateDefaultView) => {
  if (alert.source === AlertSource.SAVED_SEARCH) {
    if (savedSearch == null) {
      throw new Error(`Source is ${alert.source} but savedSearch is null`);
    }
    return buildLogSearchLink({
      endTime,
      savedSearch,
      startTime,
    });
  } else if (alert.source === AlertSource.TILE) {
    if (dashboard == null) {
      throw new Error(`Source is ${alert.source} but dashboard is null`);
    }
    return buildChartLink({
      dashboardId: dashboard.id,
      endTime,
      granularity,
      startTime,
    });
  }

  throw new Error(`Unsupported alert source: ${(alert as any).source}`);
};
export const buildAlertMessageTemplateTitle = ({
  template,
  view,
}: {
  template?: string | null;
  view: AlertMessageTemplateDefaultView;
}) => {
  const { alert, dashboard, savedSearch } = view;
  const handlebars = Handlebars.create();
  if (alert.source === AlertSource.SAVED_SEARCH) {
    if (savedSearch == null) {
      throw new Error(`Source is ${alert.source}  but savedSearch is null`);
    }
    // TODO: using template engine to render the title
    return template
      ? handlebars.compile(template)(view)
      : `Alert for "${savedSearch.name}"`;
  } else if (alert.source === AlertSource.TILE) {
    if (dashboard == null) {
      throw new Error(`Source is ${alert.source} but dashboard is null`);
    }
    const tile = dashboard.tiles[0];
    return template
      ? handlebars.compile(template)(view)
      : `Alert for "${tile.config.name}" in "${dashboard.name}"`;
  }

  throw new Error(`Unsupported alert source: ${(alert as any).source}`);
};

export const getDefaultExternalAction = (
  alert: AlertMessageTemplateDefaultView['alert'],
) => {
  if (alert.channel.type === 'webhook' && alert.channel.webhookId != null) {
    return `@${alert.channel.type}-${alert.channel.webhookId}`;
  }
  return null;
};

export const translateExternalActionsToInternal = (template: string) => {
  // ex: @webhook-1234_5678 -> "{{NOTIFY_FN_NAME channel="webhook" id="1234_5678}}"
  // ex: @webhook-{{attributes.webhookId}} -> "{{NOTIFY_FN_NAME channel="webhook" id="{{attributes.webhookId}}"}}"
  return template.replace(/(?:^|\s)@([a-zA-Z0-9.{}@_-]+)/g, (match, input) => {
    const prefix = match.startsWith(' ') ? ' ' : '';
    const [channel, ...ids] = input.split('-');
    const id = ids.join('-');
    // TODO: sanity check ??
    return `${prefix}{{${NOTIFY_FN_NAME} channel="${channel}" id="${id}"}}`;
  });
};

// this method will build the body of the alert message and will be used to send the alert to the channel
export const renderAlertTemplate = async ({
  raw,
  metadata,
  template,
  title,
  view,
  team,
  alertStartsAt,
  alertEndsAt,
  labels,
  orgId,
}: {
  raw: string;
  metadata: Metadata;
  template?: string | null;
  title: string;
  view: AlertMessageTemplateDefaultView;
  team: {
    id: string;
  };
  alertStartsAt: Date;
  alertEndsAt: Date;
  labels: Record<string, string>;
  orgId: string;
}) => {
  const { alert, dashboard, endTime, group, savedSearch, source, startTime } =
    view;

  const defaultExternalAction = getDefaultExternalAction(alert);
  const targetTemplate =
    defaultExternalAction !== null
      ? translateExternalActionsToInternal(
          `${template ?? ''} ${defaultExternalAction}`,
        ).trim()
      : translateExternalActionsToInternal(template ?? '');

  const isMatchFn = function (shouldRender: boolean) {
    return function (
      targetKey: string,
      targetValue: string,
      options: HelperOptions,
    ) {
      if (_.has(view, targetKey) && _.get(view, targetKey) === targetValue) {
        if (shouldRender) {
          return options.fn(this);
        } else {
          options.fn(this);
        }
      }
    };
  };
  const _hb = Handlebars.create();
  _hb.registerHelper(NOTIFY_FN_NAME, () => null);
  _hb.registerHelper(IS_MATCH_FN_NAME, isMatchFn(true));
  const hb = PromisedHandlebars(Handlebars);
  const registerHelpers = (
    rawTemplateBody: string,
    query: string,
    sample: string,
  ) => {
    hb.registerHelper(IS_MATCH_FN_NAME, isMatchFn(false));

    hb.registerHelper(
      NOTIFY_FN_NAME,
      async (options: { hash: Record<string, string> }) => {
        const { channel, id } = options.hash;
        if (channel !== 'webhook') {
          throw new Error(`Unsupported channel type: ${channel}`);
        }
        // render id template
        const renderedId = _hb.compile(id)(view);
        // render body template
        const renderedBody = _hb.compile(rawTemplateBody)(view);

        if (!savedSearch) {
          throw new Error('SavedSearch not found');
        }

        await notifyChannel({
          channel,
          id: renderedId,
          message: {
            hdxLink: buildAlertMessageTemplateHdxLink(view),
            title,
            query: query,
            sample: sample,
            message: renderedBody,
            alertname: savedSearch.name,
            alertStartsAt,
            alertEndsAt,
          },
          team,
          labels,
          orgId,
        });
      },
    );
  };

  const timeRangeMessage = `Time Range (UTC): [${formatDate(view.startTime, {
    isUTC: true,
  })} - ${formatDate(view.endTime, {
    isUTC: true,
  })})`;
  let rawTemplateBody;
  let query = '';
  let truncatedResults = '';
  // TODO: support advanced routing with template engine
  // users should be able to use '@' syntax to trigger alerts
  if (alert.source === AlertSource.SAVED_SEARCH) {
    if (savedSearch == null) {
      throw new Error(`Source is ${alert.source} but savedSearch is null`);
    }
    if (source == null) {
      throw new Error(`Source ID is ${alert.source} but source is null`);
    }
    // TODO: show group + total count for group-by alerts
    // fetch sample logs
    const chartConfig: ChartConfigWithOptDateRange = {
      connection: '', // no need for the connection id since clickhouse client is already initialized
      displayType: DisplayType.Search,
      dateRange: [startTime, endTime],
      from: source.from,
      select: savedSearch.select || source.defaultTableSelectExpression || '', // remove alert body if there is no select and defaultTableSelectExpression
      where: savedSearch.where,
      whereLanguage: savedSearch.whereLanguage,
      implicitColumnExpression: source.implicitColumnExpression,
      timestampValueExpression: source.timestampValueExpression,
      orderBy: savedSearch.orderBy,
      limit: {
        limit: 5,
        offset: 0,
      },
    };

    let lines = raw.split('\n');
    // 找到时间戳字段的索引
    const headers = lines[0].split(',').map(field => field.slice(1, -1));
    const timestampIndex = headers.findIndex(header =>
      header.toLowerCase().includes('timestamp'),
    );

    lines = lines.map(line =>
      line
        .split(',')
        .map((field, index) => {
          // 移除首尾的 “, 以及 csv 对 ” 的转意
          field = field.slice(1, -1);
          field = field.replace(/""/g, '"');
          // 如果是时间戳字段，使用 formatDate
          if (index === timestampIndex) {
            const date = new Date(field);
            if (isNaN(date.getTime())) {
              return field; // 解析失败，原样返回
            }
            let formattedDate = date.toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
              timeZone: 'UTC',
            });
            formattedDate += ' UTC';
            return formattedDate;
          }
          return field;
        })
        .join(' | '),
    );
    truncatedResults = truncateString(
      lines
        .map(line => truncateString(line, MAX_MESSAGE_LENGTH))
        .join('\n-----------------------------\n'),
      2500,
    );

    // 检查是否是 resolved 请求（alert_start_at 等于 alert_end_at）
    const isResolvedAlert = alertStartsAt.getTime() === alertEndsAt.getTime();

    // 根据是否是 resolved 请求来调整阈值描述
    let thresholdDescription = '';
    if (isResolvedAlert) {
      // resolved 请求：阈值逻辑反转
      thresholdDescription =
        alert.thresholdType === AlertThresholdType.ABOVE
          ? 'Less than'
          : 'More than or exactly';
    } else {
      // 正常告警请求
      thresholdDescription =
        alert.thresholdType === AlertThresholdType.ABOVE
          ? 'More than or exactly'
          : 'Less than';
    }

    // 检查是否有实际数据（除了表头）
    const hasActualData = lines.length > 1;

    query = `${thresholdDescription} ${alert.threshold} log events matched in the last ${alert.interval} against the monitored query:\n${timeRangeMessage}\n`;
    if (hasActualData) {
      truncatedResults = `
\`\`\`
${truncatedResults}
\`\`\``;
    } else {
      truncatedResults = '';
    }
  } else if (alert.source === AlertSource.TILE) {
    if (dashboard == null) {
      throw new Error(`Source is ${alert.source} but dashboard is null`);
    }
    rawTemplateBody = `${alert.threshold}\n${timeRangeMessage}
${targetTemplate}`;
  }

  // render the template
  registerHelpers(targetTemplate, query, truncatedResults);
  const compiledTemplate = hb.compile(targetTemplate);
  return compiledTemplate(view);
};
// ------------------------------------------------------------

const fireChannelEvent = async ({
  alert,
  attributes,
  raw,
  dashboard,
  endTime,
  group,
  metadata,
  savedSearch,
  source,
  startTime,
  windowSizeInMins,
  alertStartsAt,
  alertEndsAt,
}: {
  alert: EnhancedAlert;
  attributes: Record<string, string>; // TODO: support other types than string
  raw: string;
  dashboard?: IDashboard | null;
  endTime: Date;
  group?: string;
  metadata: Metadata;
  savedSearch?: ISavedSearch | null;
  source?: ISource | null;
  startTime: Date;
  windowSizeInMins: number;
  alertStartsAt: Date;
  alertEndsAt: Date;
}) => {
  const team = alert.team;
  if (team == null) {
    throw new Error('Team not found');
  }

  if ((alert.silenced?.until?.getTime() ?? 0) > Date.now()) {
    logger.info({
      message: 'Skipped firing alert due to silence',
      silenced: alert.silenced,
    });
    return;
  }

  const attributesNested = expandToNestedObject(attributes);
  const templateView: AlertMessageTemplateDefaultView = {
    alert: {
      channel: alert.channel,
      dashboardId: dashboard?.id,
      groupBy: alert.groupBy,
      interval: alert.interval,
      message: alert.message,
      name: alert.name,
      savedSearchId: savedSearch?.id,
      silenced: alert.silenced,
      source: alert.source,
      threshold: alert.threshold,
      thresholdType: alert.thresholdType,
      tileId: alert.tileId,
    },
    attributes: attributesNested,
    dashboard,
    endTime,
    granularity: `${windowSizeInMins} minute`,
    group,
    savedSearch,
    source,
    startTime,
  };

  await renderAlertTemplate({
    raw,
    metadata,
    title: buildAlertMessageTemplateTitle({
      template: alert.name,
      view: templateView,
    }),
    template: alert.message,
    view: templateView,
    team: {
      id: team._id.toString(),
    },
    alertStartsAt,
    alertEndsAt,
    labels: (alert.channel as any)?.labels,
    orgId: alert.orgId ? alert.orgId : '1',
  });
};

export const roundDownTo = (roundTo: number) => (x: Date) =>
  new Date(Math.floor(x.getTime() / roundTo) * roundTo);
export const roundDownToXMinutes = (x: number) => roundDownTo(1000 * 60 * x);

const messageLimit = 10;

export const processAlert = async (now: Date, alert: EnhancedAlert) => {
  const alertname = alert.name || 'unknown';
  try {
    const previous: IAlertHistory | undefined = (
      await AlertHistory.find({ alert: alert._id })
        .sort({ createdAt: -1 })
        .limit(1)
    )[0];

    const windowSizeInMins = ms(alert.interval) / 60000;
    // 为防止日志写入延迟，1 minute 后再进行查询。
    const nowInMinsRoundDown = roundDownToXMinutes(windowSizeInMins)(
      fns.subMinutes(now, 1),
    );
    if (
      previous &&
      fns.getTime(previous.createdAt) === fns.getTime(nowInMinsRoundDown)
    ) {
      logger.debug({
        message: `Skipped to check alert since the time diff is still less than 1 window size`,
        windowSizeInMins,
        nowInMinsRoundDown,
        previous,
        now,
        alertname: alertname,
      });
      return;
    }
    // 只查询过去一个 windowSizeInMins 的时间范围
    const checkStartTime = fns.subMinutes(nowInMinsRoundDown, windowSizeInMins);
    const checkEndTime = nowInMinsRoundDown;

    let chartConfig: ChartConfigWithOptDateRange | undefined;
    let connectionId: string | undefined;
    let savedSearch: ISavedSearch | undefined | null;
    let dashboard: IDashboard | undefined | null;
    let source: ISource | undefined | null;
    // SAVED_SEARCH Source
    if (alert.source === AlertSource.SAVED_SEARCH && alert.savedSearch) {
      savedSearch = await SavedSearch.findById(alert.savedSearch);
      if (savedSearch == null) {
        throw new Error('SavedSearch not found');
      }
      source = await Source.findById(savedSearch.source);
      if (source == null) {
        throw new Error(`Source not found, savedSearch: ${alert.savedSearch}`);
      }
      if (source.alertConnection) {
        connectionId = source.alertConnection.toString();
      } else {
        connectionId = source.connection.toString();
      }
      let limit = alert.threshold;
      if (limit < messageLimit) {
        limit = messageLimit;
      }
      chartConfig = {
        connection: connectionId,
        displayType: DisplayType.Line,
        dateRange: [checkStartTime, checkEndTime],
        dateRangeStartInclusive: true,
        dateRangeEndInclusive: false,
        from: source.from,
        select: savedSearch.select || source.defaultTableSelectExpression || '',
        where: savedSearch.where,
        whereLanguage: savedSearch.whereLanguage,
        groupBy: alert.groupBy,
        implicitColumnExpression: source.implicitColumnExpression,
        timestampValueExpression: source.timestampValueExpression,
        limit: {
          limit: limit,
        },
      };
    }
    // TILE Source
    else if (
      alert.source === AlertSource.TILE &&
      alert.dashboard &&
      alert.tileId
    ) {
      dashboard = await Dashboard.findById(alert.dashboard);
      if (dashboard == null) {
        throw new Error(`Dashboard not found, dashboardId: ${alert.dashboard}`);
      }
      // filter tiles
      dashboard.tiles = dashboard.tiles.filter(
        tile => tile.id === alert.tileId,
      );

      if (dashboard.tiles.length === 1) {
        // Doesn't work for metric alerts yet
        const MAX_NUM_GROUPS = 20;
        // TODO: assuming that the chart has only 1 series for now
        const firstTile = dashboard.tiles[0];
        if (firstTile.config.displayType === DisplayType.Line) {
          // fetch source data
          source = await Source.findById(firstTile.config.source);
          if (!source) {
            throw new Error(`Source not found, source: ${source}`);
          }
          if (source.alertConnection) {
            connectionId = source.alertConnection.toString();
          } else {
            connectionId = source.connection.toString();
          }
          chartConfig = {
            connection: connectionId,
            dateRange: [checkStartTime, checkEndTime],
            dateRangeStartInclusive: true,
            dateRangeEndInclusive: false,
            displayType: firstTile.config.displayType,
            from: source.from,
            granularity: `${windowSizeInMins} minute`,
            groupBy: firstTile.config.groupBy,
            implicitColumnExpression: source.implicitColumnExpression,
            metricTables: source.metricTables,
            select: firstTile.config.select,
            timestampValueExpression: source.timestampValueExpression,
            where: firstTile.config.where,
            seriesReturnType: firstTile.config.seriesReturnType,
          };
        }
      }
    } else {
      throw new Error(`Unsupported alert source: ${alert.source}`);
    }

    // Fetch data
    if (chartConfig == null || connectionId == null) {
      throw new Error(
        `Failed to build chart config, chartConfig: ${chartConfig}, connectionId: ${connectionId}`,
      );
    }

    const connection = await getConnectionById(
      alert.team._id.toString(),
      connectionId,
      true,
    );

    if (connection == null) {
      throw new Error(`Connection not found, connectionId: ${connectionId}`);
    }
    const clickhouseClient = new clickhouse.ClickhouseClient({
      host: connection.host,
      username: connection.username,
      password: connection.password,
    });
    const metadata = getMetadata(clickhouseClient);
    const query = await renderChartConfig(chartConfig, metadata);

    const queryStart = new Date();
    let raw = '';
    try {
      raw = await clickhouseClient
        .query<'CSVWithNames'>({
          query: query.sql,
          query_params: query.params,
          format: 'CSVWithNames',
          clickhouse_settings: {
            max_execution_time: 30,
          },
        })
        .then(res => res.text());
    } catch (e) {
      EvalFailures.labels({
        type: 'query_clickhouse',
        alertname: alertname,
      }).inc();
      throw new Error(`Failed to query clickhouse: ${e}`);
    } finally {
      EvalDuration.labels({
        type: 'query_clickhouse',
        alertname: alertname,
      }).observe(getDuration(queryStart));
    }

    // TODO: support INSUFFICIENT_DATA state
    let alertState = AlertState.OK;

    let event = {};
    const dataRowCount = raw.split('\n').length - 2; // -2 because of the header and the last empty line
    let rawLimit = dataRowCount;
    if (dataRowCount > messageLimit) {
      rawLimit = messageLimit;
    }
    raw = raw
      .split('\n')
      .slice(0, rawLimit + 1)
      .join('\n'); // messageLimit includes the header and messageLimit rows of data
    if (
      doesExceedThreshold(alert.thresholdType, alert.threshold, dataRowCount)
    ) {
      alertState = AlertState.ALERT;
      event = {
        alert,
        attributes: {}, // FIXME: support attributes (logs + resources ?)
        raw,
        dashboard,
        endTime: checkEndTime,
        metadata,
        savedSearch,
        source,
        startTime: checkStartTime,
        windowSizeInMins,
        // Allow for two Eval or Alertmanager send failures.
        // firing:
        //  - alertStartsAt now
        //  - alertEndsAt now + 4 * interval, see // https://github.com/prometheus/prometheus/blob/6a9b3263ffdba5ea8c23e6f9ef69fb7a15b566f8/rules/alerting.go#L493
        alertStartsAt: now,
        alertEndsAt: fns.addMinutes(now, 4 * windowSizeInMins),
      };
    }

    if (alertState === AlertState.ALERT) {
      // Alert has just fired
      alert.firedAt = now;
    } else if (
      alertState === AlertState.OK &&
      alert.state === AlertState.ALERT
    ) {
      // was firing but is now inactive
      alert.resolvedAt = now;
    }

    // If the alert is resolved (was firing but is now inactive) keep it for
    // at least the retention period. This is important for a number of reasons:
    //
    // 1. It allows for Prometheus to be more resilient to network issues that
    //    would otherwise prevent a resolved alert from being reported as resolved
    //    to Alertmanager.
    //
    // 2. It helps reduce the chance of resolved notifications being lost if
    //    Alertmanager crashes or restarts between receiving the resolved alert
    //    from Prometheus and sending the resolved notification. This tends to
    //    occur for routes with large Group intervals.
    if (fns.addMinutes(alert.resolvedAt, 15) > now) {
      raw = '';
      event = {
        alert,
        attributes: {}, // FIXME: support attributes (logs + resources ?)
        raw,
        dashboard,
        endTime: checkEndTime,
        metadata,
        savedSearch,
        source,
        startTime: checkStartTime,
        windowSizeInMins,
        alertStartsAt: now,
        alertEndsAt: now,
      };
    }

    // Only fire the event if it is not empty
    if (Object.keys(event).length > 0) {
      const sendStart = new Date();
      try {
        await fireChannelEvent(event as Parameters<typeof fireChannelEvent>[0]);
      } catch (e) {
        EvalFailures.labels({
          type: 'send_alert',
          alertname: alertname,
        }).inc();
        throw new Error(`Failed to fire channel event: ${e}`);
      } finally {
        EvalDuration.labels({
          type: 'send_alert',
          alertname: alertname,
        }).observe(getDuration(sendStart));
      }
    }

    // 通知 alermanager 成功后再更新 history。
    // 这样如果 interval 是 10minute, 那么下次调度的时候会重新执行。
    await new AlertHistory({
      alert: alert._id,
      createdAt: nowInMinsRoundDown,
      state: alertState,
      counts: 1,
      lastValues: [{ count: dataRowCount, startTime: checkStartTime }],
    }).save();

    logger.debug({
      message: 'set next state',
      alertname: alert.name,
      alertState,
      previousState: alert.state,
    });
    alert.state = alertState;
    await alert.save();
  } catch (e) {
    throw new Error(
      `Failed to process alert: ${JSON.stringify(serializeError(e))}`,
    );
  }
};

const runningAlerts = new Map<string, Date>();

export default async () => {
  // 尝试获取分布式锁
  try {
    const acquired = await DistributedLock.acquireLock(120);
    if (acquired) {
      LockAcquireState.set(1);
    } else {
      LockAcquireState.set(0);
      return;
    }
  } catch (error) {
    logger.error('Error acquiring lock:', serializeError(error));
    LockAcquireError.inc();
    return;
  }
  const scheduledAt = new Date();
  const alerts = await getAlerts();
  logger.info(`Going to process ${alerts.length} alerts`);

  // 每一个 alert 都异步执行，这样如果一个 alert 执行时间过长，不会影响其他的 alert
  alerts.forEach(alert => {
    // 将 alert 均匀分布在 1 minute 内执行以减少数据库的压力。
    const alertId = alert._id.toString();
    const delayMs = (fnv.fast1a32(alertId) % 60) * 1000;
    setTimeout(() => {
      // 如果之前的 alert 还在执行，则跳过本次执行
      if (runningAlerts.has(alertId)) {
        logger.error({
          message: 'Skip processing; alert already running',
          alertname: alert.name,
          startedAt: runningAlerts.get(alertId),
        });
        EvaluationMissed.inc({
          alertname: alert.name ?? 'unknown',
        });
        return;
      }
      runningAlerts.set(alertId, scheduledAt);
      const evalStart = new Date();

      // 函数 processAlert 会将所有 catch 的 error throw 出来
      // 这样在 attempt 中可以捕获到 processAlert 的错误
      // 如果 processAlert 失败，则重试 MAX_ATTEMPTS 次
      const attempt = async (retries: number): Promise<void> => {
        try {
          await processAlert(scheduledAt, alert);

          logger.debug({
            message: 'Tick processed',
            alertname: alert.name,
            scheduledAt,
            retries,
            duration: getDuration(evalStart),
          });
        } catch (err) {
          logger.error({
            message: 'Failed to evaluate rule',
            alertname: alert.name,
            retries,
            scheduledAt,
            duration: getDuration(evalStart),
            error: serializeError(err),
          });
          if (retries < MAX_ATTEMPTS) {
            EvalRetry.inc({ alertname: alert.name ?? 'unknown' });
            await new Promise<void>(resolve =>
              setTimeout(resolve, RETRY_DELAY_MS),
            );
            return attempt(retries + 1);
          }
          // Only count the final attempt as a failure.
          EvalFailures.inc({
            alertname: alert.name ?? 'unknown',
            type: 'final',
          });
          // no more retries
          return;
        }
      };
      void attempt(1).finally(() => {
        EvalDuration.labels({
          type: 'total',
          alertname: alert.name ?? 'unknown',
        }).observe(getDuration(evalStart));
        runningAlerts.delete(alertId);
      });
    }, delayMs);
  });
};

const getDuration = (start: Date) => {
  return (new Date().getTime() - start.getTime()) / 1000;
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

const EvaluationMissed = new Prometheus.Counter({
  name: 'schedule_rule_evaluations_missed_total',
  help: 'The total number of rule evaluations missed due to a slow rule evaluation or schedule problem.',
  labelNames: ['alertname'],
});

const EvalDuration = new Prometheus.Summary({
  name: 'rule_evaluation_duration_seconds',
  help: 'The time to evaluate a rule.',
  labelNames: ['alertname', 'type'],
  percentiles: [0.5, 0.9, 0.99],
});

const EvalRetry = new Prometheus.Counter({
  name: 'rule_evaluation_retry_total',
  help: 'The total number of rule retry.',
  labelNames: ['alertname'],
});

const EvalFailures = new Prometheus.Counter({
  name: 'rule_evaluation_failures_total',
  help: 'The total number of rule evaluation failures.',
  labelNames: ['alertname', 'type'],
});

const LockAcquireError = new Prometheus.Counter({
  name: 'alert_lock_acquire_error_total',
  help: 'The total number of lock acquisition errors.',
});

const LockAcquireState = new Prometheus.Gauge({
  name: 'alert_lock_acquire_state',
  help: 'The state of the lock acquisition.',
  labelNames: ['state'],
});
