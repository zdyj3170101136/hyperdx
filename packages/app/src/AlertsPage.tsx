import * as React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import cx from 'classnames';
import { formatRelative } from 'date-fns';
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs';
import {
  AlertHistory,
  AlertSource,
  AlertState,
} from '@hyperdx/common-utils/dist/types';
import {
  Alert,
  Badge,
  Container,
  Group,
  Pagination,
  Stack,
  TextInput,
  Tooltip,
} from '@mantine/core';

import { PageHeader } from '@/components/PageHeader';

import api from './api';
import { withAppNav } from './layout';
import type { AlertsPageItem } from './types';

import styles from '../styles/AlertsPage.module.scss';

// TODO: exceptions latestHighestValue needs to be different condition (total count of exceptions not highest value within an exception)

function AlertHistoryCard({ history }: { history: AlertHistory }) {
  const start = new Date(history.createdAt.toString());
  const today = React.useMemo(() => new Date(), []);
  const latestHighestValue = history.lastValues.length
    ? Math.max(...history.lastValues.map(({ count }) => count))
    : 0;

  return (
    <Tooltip
      label={latestHighestValue + ' ' + formatRelative(start, today)}
      color="dark"
      withArrow
    >
      <div
        className={cx(
          styles.historyCard,
          history.state === AlertState.OK ? styles.ok : styles.alarm,
        )}
      />
    </Tooltip>
  );
}

const HISTORY_ITEMS = 18;

function AlertHistoryCardList({ history }: { history: AlertHistory[] }) {
  const items = React.useMemo(() => {
    if (history.length < HISTORY_ITEMS) {
      return history;
    }
    return history.slice(0, HISTORY_ITEMS);
  }, [history]);

  const paddingItems = React.useMemo(() => {
    if (history.length > HISTORY_ITEMS) {
      return [];
    }
    return new Array(HISTORY_ITEMS - history.length).fill(null);
  }, [history]);

  return (
    <div className={styles.historyCardWrapper}>
      {paddingItems.map((_, index) => (
        <Tooltip label="No data" color="dark" withArrow key={index}>
          <div className={styles.historyCard} />
        </Tooltip>
      ))}
      {items
        .slice()
        .reverse()
        .map((history, index) => (
          <AlertHistoryCard key={index} history={history} />
        ))}
    </div>
  );
}

function AlertDetails({ alert }: { alert: AlertsPageItem }) {
  const alertName = React.useMemo(() => {
    // Use alert.name directly
    return alert.name || '–';
  }, [alert]);

  const alertUrl = React.useMemo(() => {
    if (alert.source === AlertSource.TILE && alert.dashboard) {
      return `/dashboards/${alert.dashboardId}?highlightedTileId=${alert.tileId}`;
    }
    if (alert.source === AlertSource.SAVED_SEARCH && alert.savedSearch) {
      return `/search/${alert.savedSearchId}`;
    }
    return '';
  }, [alert]);

  const alertIcon = (() => {
    switch (alert.source) {
      case AlertSource.TILE:
        return 'bi-graph-up';
      case AlertSource.SAVED_SEARCH:
        return 'bi-layout-text-sidebar-reverse';
      default:
        return 'bi-question';
    }
  })();

  const linkTitle = React.useMemo(() => {
    switch (alert.source) {
      case AlertSource.TILE:
        return 'Dashboard tile';
      case AlertSource.SAVED_SEARCH:
        return 'Saved search';
      default:
        return '';
    }
  }, [alert]);

  return (
    <div className={styles.alertRow}>
      <Group style={{ flex: 1 }} gap="md">
        {/* STATUS Column */}
        <div style={{ minWidth: 80 }}>
          {alert.state === AlertState.ALERT && (
            <Badge variant="light" color="red" size="md">
              ALERT
            </Badge>
          )}
          {alert.state === AlertState.OK && (
            <Badge variant="light" color="green" size="md">
              OK
            </Badge>
          )}
          {alert.state === AlertState.DISABLED && (
            <Badge variant="light" color="gray" size="md">
              Disabled
            </Badge>
          )}
        </div>

        {/* NAME Column */}
        <Stack gap={2} style={{ flex: 1 }}>
          <div>
            <Link
              href={alertUrl}
              className={styles.alertLink}
              title={linkTitle}
            >
              <i className={`bi ${alertIcon} text-slate-200 me-2 fs-8`} />
              {alertName}
            </Link>
          </div>
        </Stack>
      </Group>

      <Group>
        <AlertHistoryCardList history={alert.history} />
      </Group>
    </div>
  );
}

type SortColumn = 'status' | 'name' | null;
type SortOrder = 'asc' | 'desc';

function AlertCardList({
  alerts,
  sortColumn,
  order,
}: {
  alerts: AlertsPageItem[];
  sortColumn: SortColumn;
  order: SortOrder | null;
}) {
  const [, setSortParam] = useQueryState(
    'sort',
    parseAsString.withDefault('name'),
  );
  const [, setOrderParam] = useQueryState(
    'order',
    parseAsString.withDefault('asc'),
  );

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      // If clicking the same column, cycle through: asc -> desc -> remove
      if (order === 'asc') {
        setOrderParam('desc');
      } else {
        // Remove sorting (set to null) and clear order parameter
        setSortParam(null);
        setOrderParam(null); // Clear order parameter from URL
      }
    } else {
      // Set new column and default to asc
      setSortParam(column);
      setOrderParam('asc');
    }
  };

  const TableHeader = () => (
    <div className={styles.tableHeader}>
      <div
        style={{ minWidth: 80 }}
        className={styles.sortableHeader}
        onClick={() => handleSort('status')}
      >
        STATUS
        {sortColumn === 'status' && (
          <i
            className={`bi bi-caret-${
              order === 'asc' ? 'up' : 'down'
            }-fill ms-1`}
            style={{ color: 'var(--mantine-color-blue-6)' }}
          />
        )}
      </div>
      <div
        style={{ flex: 1 }}
        className={styles.sortableHeader}
        onClick={() => handleSort('name')}
      >
        NAME
        {sortColumn === 'name' && (
          <i
            className={`bi bi-caret-${
              order === 'asc' ? 'up' : 'down'
            }-fill ms-1`}
            style={{ color: 'var(--mantine-color-blue-6)' }}
          />
        )}
      </div>
      <div style={{ minWidth: 200 }}></div>
    </div>
  );

  if (alerts.length === 0) {
    return (
      <div className="text-center text-slate-400 my-4 fs-8">No alerts</div>
    );
  }

  return (
    <div>
      <TableHeader />
      {alerts.map((alert, index) => (
        <AlertDetails key={index} alert={alert} />
      ))}
    </div>
  );
}

export default function AlertsPage() {
  const limit = 10;

  // Get pagination and sort parameters from URL
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));
  const [sortParam] = useQueryState('sort');
  const [orderParam] = useQueryState('order');
  const [searchQuery, setSearchQuery] = useQueryState('q');

  // Local state for search input (only updates URL on Enter)
  const [searchInput, setSearchInput] = React.useState(searchQuery || '');

  // Sync local input with URL query when URL changes (e.g., from browser back/forward)
  React.useEffect(() => {
    setSearchInput(searchQuery || '');
  }, [searchQuery]);

  // Reset page to 1 when search query changes
  React.useEffect(() => {
    setPage(1);
  }, [searchQuery, setPage]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const value = e.currentTarget.value.trim() || null;
      setSearchQuery(value);
      if (value && page !== 1) {
        setPage(1);
      }
    }
  };

  const sort =
    sortParam === 'status' || sortParam === 'name' ? sortParam : null;
  const order =
    orderParam === 'asc' || orderParam === 'desc' ? orderParam : null;

  const { data, isError, isLoading } = api.useAlerts(
    page,
    limit,
    sort,
    order,
    searchQuery,
  );

  const alerts = React.useMemo(() => data?.data || [], [data?.data]);
  const pagination = data?.pagination;

  return (
    <div className="AlertsPage">
      <Head>
        <title>Alerts - HyperDX</title>
      </Head>
      <PageHeader>Alerts</PageHeader>
      <div className="my-4">
        <Container maw={1500}>
          <Alert
            icon={<i className="bi bi-info-circle-fill text-slate-400" />}
            color="gray"
            py="xs"
            mt="md"
          >
            Alerts can be{' '}
            <a
              href="https://metabit-trading.feishu.cn/docx/GxYhdPZiXomKOFxdem1cIdi1nUd#share-UKZTd53HKopXuyxAvX2cNTJcnnf"
              target="_blank"
              rel="noopener noreferrer"
            >
              created
            </a>{' '}
            from dashboard charts and saved searches.
          </Alert>
          <TextInput
            placeholder="Search alerts by name... (Press Enter to search)"
            value={searchInput}
            onChange={e => setSearchInput(e.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
            leftSection={<i className="bi bi-search fs-8 text-slate-400" />}
            rightSection={
              searchInput ? (
                <i
                  className="bi bi-x-circle fs-8 text-slate-400 cursor-pointer"
                  onClick={() => {
                    setSearchInput('');
                    setSearchQuery(null);
                    if (page !== 1) {
                      setPage(1);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                />
              ) : null
            }
            mb="md"
            mt="md"
            size="sm"
          />
          {isLoading ? (
            <div className="text-center text-slate-400 my-4 fs-8">
              Loading...
            </div>
          ) : isError ? (
            <div className="text-center text-slate-400 my-4 fs-8">Error</div>
          ) : alerts?.length ? (
            <>
              <AlertCardList alerts={alerts} sortColumn={sort} order={order} />
              {pagination && pagination.totalPages > 1 && (
                <div className="d-flex justify-content-center mt-4">
                  <Pagination
                    value={page}
                    onChange={setPage}
                    total={pagination.totalPages}
                    size="sm"
                  />
                </div>
              )}
            </>
          ) : (
            <div className="text-center text-slate-400 my-4 fs-8">
              No alerts created yet
            </div>
          )}
        </Container>
      </div>
    </div>
  );
}

AlertsPage.getLayout = withAppNav;
