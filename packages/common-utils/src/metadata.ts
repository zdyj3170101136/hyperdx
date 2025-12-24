import {
  ChSql,
  chSql,
  ClickhouseClient,
  ColumnMeta,
  convertCHDataTypeToJSType,
  filterColumnMetaByType,
  JSDataType,
  tableExpr,
} from '@/clickhouse';
import { renderChartConfig } from '@/renderChartConfig';
import type {
  ChartConfig,
  ChartConfigWithDateRange,
  ChartConfigWithOptDateRange,
  TSource,
} from '@/types';

// If filters initially are taking too long to load, decrease this number.
// Between 1e6 - 5e6 is a good range.
export const DEFAULT_MAX_ROWS_TO_READ = 3e6;

export class MetadataCache {
  private cache = new Map<string, any>();
  private pendingQueries = new Map<string, Promise<any>>();

  // this should be getOrUpdate... or just query to follow react query
  get<T>(key: string): T | undefined {
    return this.cache.get(key);
  }

  async getOrFetch<T>(key: string, query: () => Promise<T>): Promise<T> {
    // Check if value exists in cache
    const cachedValue = this.cache.get(key) as T | undefined;
    if (cachedValue != null) {
      return cachedValue;
    }

    // Check if there is a pending query
    if (this.pendingQueries.has(key)) {
      return this.pendingQueries.get(key)!;
    }

    // If no pending query, initiate the new query
    const queryPromise = query();

    // Store the pending query promise
    this.pendingQueries.set(key, queryPromise);

    try {
      const result = await queryPromise;
      this.cache.set(key, result);
      return result;
    } finally {
      // Clean up the pending query map
      this.pendingQueries.delete(key);
    }
  }

  set<T>(key: string, value: T) {
    return this.cache.set(key, value);
  }

  // TODO: This needs to be async, and use tanstack query on frontend for cache
  // TODO: Implement locks for refreshing
  // TODO: Shard cache by time
}

export type TableMetadata = {
  database: string;
  name: string;
  uuid: string;
  engine: string;
  is_temporary: number;
  data_paths: string[];
  metadata_path: string;
  metadata_modification_time: string;
  metadata_version: number;
  create_table_query: string;
  engine_full: string;
  as_select: string;
  partition_key: string;
  sorting_key: string;
  primary_key: string;
  sampling_key: string;
  storage_policy: string;
  total_rows: string;
  total_bytes: string;
  total_bytes_uncompressed: string;
  parts: string;
  active_parts: string;
  total_marks: string;
  comment: string;
};

export class Metadata {
  private readonly clickhouseClient: ClickhouseClient;
  private readonly cache: MetadataCache;

  constructor(clickhouseClient: ClickhouseClient, cache: MetadataCache) {
    this.clickhouseClient = clickhouseClient;
    this.cache = cache;
  }

  private async queryTableMetadata({
    database,
    table,
    cache,
    connectionId,
  }: {
    database: string;
    table: string;
    cache: MetadataCache;
    connectionId: string;
  }) {
    return cache.getOrFetch(`${database}.${table}.metadata`, async () => {
      const sql = chSql`SELECT * FROM system.tables where database = ${{ String: database }} AND name = ${{ String: table }}`;
      const json = await this.clickhouseClient
        .query<'JSON'>({
          connectionId,
          query: sql.sql,
          query_params: sql.params,
        })
        .then(res => res.json<TableMetadata>());
      return json.data[0];
    });
  }

  async getColumns({
    databaseName,
    tableName,
    connectionId,
  }: {
    databaseName: string;
    tableName: string;
    connectionId: string;
  }) {
    return this.cache.getOrFetch<ColumnMeta[]>(
      `${databaseName}.${tableName}.columns`,
      async () => {
        const sql = chSql`DESCRIBE ${tableExpr({ database: databaseName, table: tableName })}`;
        const columns = await this.clickhouseClient
          .query<'JSON'>({
            query: sql.sql,
            query_params: sql.params,
            connectionId,
          })
          .then(res => res.json())
          .then(d => d.data);
        return columns as ColumnMeta[];
      },
    );
  }

  async getMaterializedColumnsLookupTable({
    databaseName,
    tableName,
    connectionId,
  }: {
    databaseName: string;
    tableName: string;
    connectionId: string;
  }) {
    const columns = await this.getColumns({
      databaseName,
      tableName,
      connectionId,
    });

    // Build up materalized fields lookup table
    return new Map(
      columns
        .filter(
          c =>
            c.default_type === 'MATERIALIZED' || c.default_type === 'DEFAULT',
        )
        .map(c => [c.default_expression, c.name]),
    );
  }

  async getColumn({
    databaseName,
    tableName,
    column,
    matchLowercase = false,
    connectionId,
  }: {
    databaseName: string;
    tableName: string;
    column: string;
    matchLowercase?: boolean;
    connectionId: string;
  }): Promise<ColumnMeta | undefined> {
    const tableColumns = await this.getColumns({
      databaseName,
      tableName,
      connectionId,
    });

    return tableColumns.filter(c => {
      if (matchLowercase) {
        return c.name.toLowerCase() === column.toLowerCase();
      }

      return c.name === column;
    })[0];
  }

  async getMapKeys({
    databaseName,
    tableName,
    column,
    maxKeys = 1000,
    connectionId,
    metricName,
    chartConfig,
  }: {
    databaseName: string;
    tableName: string;
    column: string;
    maxKeys?: number;
    connectionId: string;
    metricName?: string;
    chartConfig?: ChartConfigWithDateRange;
  }) {
    let cacheKey = metricName
      ? `${databaseName}.${tableName}.${column}.${metricName}.keys`
      : `${databaseName}.${tableName}.${column}.keys`;
    cacheKey = `${cacheKey}.${JSON.stringify(chartConfig)}`;
    const cachedKeys = this.cache.get<string[]>(cacheKey);

    if (cachedKeys != null) {
      return cachedKeys;
    }

    const colMeta = await this.getColumn({
      databaseName,
      tableName,
      column,
      connectionId,
    });

    if (colMeta == null) {
      throw new Error(
        `Column ${column} not found in ${databaseName}.${tableName}`,
      );
    }

    let strategy:
      | 'groupUniqArrayArray'
      | 'lowCardinalityKeys'
      | 'groupUniqArrayArrayMerge' = 'groupUniqArrayArray';
    if (colMeta.type.startsWith('Map(LowCardinality(String)')) {
      if (
        ['LogAttributes', 'ResourceAttributes', 'ScopeAttributes'].includes(
          colMeta.name,
        )
      ) {
        strategy = 'groupUniqArrayArrayMerge';
      } else {
        strategy = 'lowCardinalityKeys';
      }
    }

    let keysArr = true;
    const where = metricName
      ? chSql`WHERE MetricName=${{ String: metricName }}`
      : '';
    let sql: ChSql;
    if (strategy === 'groupUniqArrayArray') {
      if (chartConfig) {
        sql = await renderChartConfig(
          {
            ...convertToChartConfigWithOptDateRange(chartConfig),
            // groupUniqArray 需要扫描所有数据，使用 distinct 替代。
            select: `groupUniqArrayArray(${maxKeys})(${column}) as keysArr`,
          },
          this,
        );
      } else {
        sql = chSql`SELECT groupUniqArrayArray(${{ Int32: maxKeys }})(${{
          Identifier: column,
        }}) as keysArr
        FROM ${tableExpr({ database: databaseName, table: tableName })} ${where}`;
      }
    } else if (strategy === 'groupUniqArrayArrayMerge') {
      if (chartConfig) {
        // 将获取 mapKeys 替换成对 attributes_keys_aggregate 的搜索
        // 因为 max_rows_to_read 不精确
        // 而且用户 role 携带的参数会导致查询速度大大减慢
        sql = await renderChartConfig(
          {
            ...convertToChartConfigWithOptDateRange(chartConfig),
            timestampValueExpression: 'Date',
            from: {
              ...chartConfig.from,
              tableName: 'attributes_keys_aggregate',
            },
            // groupUniqArray 需要扫描所有数据，使用 distinct 替代。
            select: `groupUniqArrayArrayMerge(${column}KeysState) as keysArr`,
          },
          this,
        );
      } else {
        sql = chSql`SELECT groupUniqArrayArrayMerge(${column}KeysState) as keysArr
        FROM ${tableExpr({ database: databaseName, table: 'attributes_keys_aggregate' })} ${where}`;
      }
    } else {
      keysArr = false;
      if (chartConfig) {
        chartConfig.limit = {
          limit: maxKeys,
        };
        sql = await renderChartConfig(
          {
            ...convertToChartConfigWithOptDateRange(chartConfig),
            // groupUniqArray 需要扫描所有数据，使用 distinct 替代。
            select: `DISTINCT lowCardinalityKeys(arrayJoin(${column}.keys)) as key`,
          },
          this,
        );
      } else {
        sql = chSql`SELECT DISTINCT lowCardinalityKeys(arrayJoin(${{
          Identifier: column,
        }}.keys)) as key
        FROM ${tableExpr({ database: databaseName, table: tableName })} ${where}
        LIMIT ${{
          Int32: maxKeys,
        }}`;
      }
    }

    return this.cache.getOrFetch<string[]>(cacheKey, async () => {
      const keys = await this.clickhouseClient
        .query<'JSON'>({
          query: sql.sql,
          query_params: sql.params,
          connectionId,
          clickhouse_settings: {
            max_rows_to_read: String(DEFAULT_MAX_ROWS_TO_READ),
            read_overflow_mode: 'break',
          },
        })
        .then(res => res.json<Record<string, unknown>>())
        .then(d => {
          let output: string[];
          if (keysArr) {
            output = d.data[0].keysArr as string[];
          } else {
            output = d.data.map(row => row.key) as string[];
          }

          return output.filter(r => r);
        });
      return keys;
    });
  }

  async getMapValues({
    databaseName,
    tableName,
    column,
    key,
    maxValues = 20,
    connectionId,
  }: {
    databaseName: string;
    tableName: string;
    column: string;
    key?: string;
    maxValues?: number;
    connectionId: string;
  }) {
    const cachedValues = this.cache.get<string[]>(
      `${databaseName}.${tableName}.${column}.${key}.values`,
    );

    if (cachedValues != null) {
      return cachedValues;
    }

    const sql = key
      ? chSql`
      SELECT DISTINCT ${{
        Identifier: column,
      }}[${{ String: key }}] as value
      FROM ${tableExpr({ database: databaseName, table: tableName })}
      WHERE value != ''
      LIMIT ${{
        Int32: maxValues,
      }}
    `
      : chSql`
      SELECT DISTINCT ${{
        Identifier: column,
      }} as value
      FROM ${tableExpr({ database: databaseName, table: tableName })}
      WHERE value != ''
      LIMIT ${{
        Int32: maxValues,
      }}
    `;

    return this.cache.getOrFetch<string[]>(
      `${databaseName}.${tableName}.${column}.${key}.values`,
      async () => {
        const values = await this.clickhouseClient
          .query<'JSON'>({
            query: sql.sql,
            query_params: sql.params,
            connectionId,
            clickhouse_settings: {
              max_rows_to_read: String(DEFAULT_MAX_ROWS_TO_READ),
              read_overflow_mode: 'break',
            },
          })
          .then(res => res.json<Record<string, unknown>>())
          .then(d => d.data.map(row => row.value as string));
        return values;
      },
    );
  }

  async getAllFields(
    { databaseName, tableName, connectionId, metricName }: TableConnection,
    chartConfig?: ChartConfigWithDateRange,
  ) {
    const fields: Field[] = [];
    const columns = await this.getColumns({
      databaseName,
      tableName,
      connectionId,
    });

    for (const c of columns) {
      fields.push({
        path: [c.name],
        type: c.type,
        jsType: convertCHDataTypeToJSType(c.type),
      });
    }

    const mapColumns = filterColumnMetaByType(columns, [JSDataType.Map]) ?? [];

    await Promise.all(
      mapColumns.map(async column => {
        const keys = await this.getMapKeys({
          databaseName,
          tableName,
          column: column.name,
          connectionId,
          metricName,
          chartConfig,
        });

        const match = column.type.match(/Map\(.+,\s*(.+)\)/);
        const chType = match?.[1] ?? 'String'; // default to string ?

        for (const key of keys) {
          fields.push({
            path: [column.name, key],
            type: chType,
            jsType: convertCHDataTypeToJSType(chType),
          });
        }
      }),
    );

    return fields;
  }

  async getTableMetadata({
    databaseName,
    tableName,
    connectionId,
  }: {
    databaseName: string;
    tableName: string;
    connectionId: string;
  }) {
    const tableMetadata = await this.queryTableMetadata({
      cache: this.cache,
      database: databaseName,
      table: tableName,
      connectionId,
    });

    // partition_key which includes parenthesis, unlike other keys such as 'primary_key' or 'sorting_key'
    if (
      tableMetadata.partition_key.startsWith('(') &&
      tableMetadata.partition_key.endsWith(')')
    ) {
      tableMetadata.partition_key = tableMetadata.partition_key.slice(1, -1);
    }
    return tableMetadata;
  }

  // 当 keys 有多个的时候，使用 groupUniqArray 查询。
  // 当 keys 只有一个的时候，使用 distinct 查询。
  async getKeyValues({
    chartConfig,
    keys,
    limit = 20,
    disableRowLimit = false,
    abort_signal,
  }: {
    chartConfig: ChartConfigWithDateRange;
    keys: string[];
    limit?: number;
    disableRowLimit?: boolean;
    abort_signal?: AbortSignal;
  }) {
    chartConfig.limit = {
      limit: limit,
    };
    return this.cache.getOrFetch(
      `values.${JSON.stringify(chartConfig)}.${keys.join(',')}.${disableRowLimit}`,
      async () => {
        let sql: ChSql;
        if (keys.length > 1) {
          sql = await renderChartConfig(
            {
              ...chartConfig,
              limit: {},
              select: keys
                .map((k, i) => `groupUniqArray(${limit})(${k}) AS param${i}`)
                .join(', '),
            },
            this,
          );
        } else {
          sql = await renderChartConfig(
            {
              ...convertToChartConfigWithOptDateRange(chartConfig),
              // groupUniqArray 需要扫描所有数据，使用 distinct 替代。
              select: `DISTINCT ${keys[0]} AS param0`,
            },
            this,
          );
        }

        const json = await this.clickhouseClient
          .query<'JSON'>({
            query: sql.sql,
            query_params: sql.params,
            connectionId: chartConfig.connection,
            abort_signal,
            clickhouse_settings: !disableRowLimit
              ? {
                  max_rows_to_read: String(DEFAULT_MAX_ROWS_TO_READ),
                  read_overflow_mode: 'break',
                }
              : undefined,
          })
          .then(res => res.json<any>());

        if (keys.length > 1) {
          // 处理 groupUniqArray 的结果
          return Object.entries(json?.data?.[0] || {}).map(([key, value]) => ({
            key: keys[parseInt(key.replace('param', ''))],
            value: (value as string[])?.filter(Boolean), // remove nulls
          }));
        } else {
          // 处理 DISTINCT 的结果 - 只有一个 key，直接收集所有值
          const values: string[] = [];
          for (const dataRow of Object.values(json?.data || [])) {
            const value = Object.values(dataRow)[0] as string;
            if (value && value !== '') {
              values.push(value);
            }
          }

          return [
            {
              key: keys[0],
              value: values,
            },
          ];
        }
      },
    );
  }
}

export type Field = {
  path: string[];
  type: string;
  jsType: JSDataType | null;
};

export type TableConnection = {
  databaseName: string;
  tableName: string;
  connectionId: string;
  metricName?: string;
};

export function tcFromChartConfig(config?: ChartConfig): TableConnection {
  return {
    databaseName: config?.from?.databaseName ?? '',
    tableName: config?.from?.tableName ?? '',
    connectionId: config?.connection ?? '',
  };
}

export function tcFromSource(source?: TSource): TableConnection {
  return {
    databaseName: source?.from?.databaseName ?? '',
    tableName: source?.from?.tableName ?? '',
    connectionId: source?.connection ?? '',
  };
}

const __LOCAL_CACHE__ = new MetadataCache();

// TODO: better to init the Metadata object on the client side
// also the client should be able to choose the cache strategy
export const getMetadata = (clickhouseClient: ClickhouseClient) =>
  new Metadata(clickhouseClient, __LOCAL_CACHE__);

// 如果 timestampValueExpression 为空，则设置 timestampValueExpression 为 undefined
// 这样 ChartConfigWithOptDateRange 就不会使用时间戳筛选条件
function convertToChartConfigWithOptDateRange(
  chartConfig: ChartConfigWithDateRange,
): ChartConfigWithOptDateRange {
  // 直接返回所有值，保持所有属性
  const result: ChartConfigWithOptDateRange = {
    ...chartConfig,
  };
  if (chartConfig.timestampValueExpression == '') {
    result.timestampValueExpression = undefined;
    result.dateRange = undefined;
  }
  return result;
}
