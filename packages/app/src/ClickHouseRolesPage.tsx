import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { ClickHouseQueryError } from '@hyperdx/common-utils/dist/clickhouse';
import { chSql } from '@hyperdx/common-utils/dist/clickhouse';
import { Anchor, Box, Group, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import api from '@/api';
import { getClickhouseClient } from '@/clickhouse';
import { IS_LOCAL_MODE } from '@/config';
import { useConnections } from '@/connection';
import { withAppNav } from '@/layout';

type RolePermission = {
  role: string;
  permission: string;
};

function ClickHouseRolesPage() {
  const { data: connections } = useConnections();
  const { data: meData } = api.useMe();

  // Find connection with name "alert"
  const alertConnectionId = useMemo(() => {
    const alertConnection = connections?.find(conn => conn.name === 'alert');
    return alertConnection?.id ?? '';
  }, [connections]);

  // Get ClickHouse username from user data
  // Note: You may need to adjust this based on how username is stored
  const clickhouseUsername = useMemo(() => {
    // Try to get username from meData, or use email as fallback
    // You may need to adjust this based on your actual user data structure
    if (IS_LOCAL_MODE) {
      return 'default'; // Default user for local mode
    }
    return (
      meData?.clickhouseUsername || meData?.email?.split('@')[0] || 'default'
    );
  }, [meData]);

  const { data, isLoading, error } = useQuery<RolePermission[], Error>({
    queryKey: ['clickhouse-roles', alertConnectionId, clickhouseUsername],
    queryFn: async ({ signal }) => {
      if (!alertConnectionId || !clickhouseUsername) {
        return [];
      }

      const clickhouseClient = getClickhouseClient();
      // Use parameterized query to prevent SQL injection
      const query = chSql`
        SELECT 
          short_name as role, 
          select_filter as permission 
        FROM system.row_policies 
        WHERE short_name IN (
          SELECT granted_role_name 
          FROM system.role_grants 
          WHERE user_name = ${{
            String: clickhouseUsername,
          }}
        )
        ORDER BY role,permission
      `;

      try {
        const response = await clickhouseClient.query<'JSON'>({
          query: query.sql,
          query_params: query.params,
          format: 'JSON',
          abort_signal: signal,
          connectionId: alertConnectionId,
        });

        const result = await response.json();
        return (result.data as RolePermission[]) || [];
      } catch (err) {
        if (err instanceof ClickHouseQueryError) {
          throw new Error(
            `ClickHouse query error: ${err.message}. Query: ${err.query}`,
          );
        }
        throw err;
      }
    },
    enabled: Boolean(alertConnectionId && clickhouseUsername),
    retry: false,
  });

  return (
    <Box p="md">
      <Group mb="md" align="center" gap="xs">
        <Title order={2}>Roles</Title>
        <Anchor
          href="https://metabit-trading.feishu.cn/docx/GxYhdPZiXomKOFxdem1cIdi1nUd#share-SmOXdO6ZuoCR2axF7AlcLLLjnlf"
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
          c="dimmed"
          style={{ textDecoration: 'none' }}
        >
          <i className="bi bi-book me-1" />
          Documentation
        </Anchor>
      </Group>

      {!alertConnectionId && (
        <Text c="red" size="sm" mb="md">
          Error: Connection named &quot;alert&quot; not found
        </Text>
      )}

      <Text size="sm" c="dimmed" mb="md">
        User:{' '}
        <Text span c="gray.3">
          {clickhouseUsername}
        </Text>
      </Text>

      {error && (
        <Text c="red" size="sm" mb="md">
          Error loading roles: {error.message}
        </Text>
      )}

      {isLoading && (
        <Text size="sm" c="dimmed">
          Loading roles...
        </Text>
      )}

      {!isLoading && !error && data && (
        <>
          {data.length === 0 ? (
            <Text size="sm" c="dimmed">
              No roles found for user &quot;{clickhouseUsername}&quot;
            </Text>
          ) : (
            <Box>
              <Table
                highlightOnHover
                style={{
                  borderCollapse: 'collapse',
                }}
              >
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ borderBottom: '1px solid #444' }}>
                      Role
                    </Table.Th>
                    <Table.Th style={{ borderBottom: '1px solid #444' }}>
                      Permission
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.map((item, index) => (
                    <Table.Tr key={index}>
                      <Table.Td
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid #333',
                        }}
                      >
                        <Text size="sm" c="gray.3">
                          {item.role}
                        </Text>
                      </Table.Td>
                      <Table.Td
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid #333',
                        }}
                      >
                        <Text
                          size="sm"
                          c="gray.4"
                          style={{
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'monospace',
                          }}
                        >
                          {item.permission || '(no filter)'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

const ClickHouseRolesPageDynamic = dynamic(async () => ClickHouseRolesPage, {
  ssr: false,
});

// @ts-ignore
ClickHouseRolesPageDynamic.getLayout = withAppNav;

export default ClickHouseRolesPageDynamic;
