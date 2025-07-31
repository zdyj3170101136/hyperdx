import { useCallback, useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import router from 'next/router';
import { useAtom, useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import get from 'lodash/get';
import {
  ActionIcon,
  Box,
  Button,
  Flex,
  Group,
  Input,
  Menu,
  Paper,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';

import HyperJson, { GetLineActions, LineAction } from '@/components/HyperJson';
import { mergePath } from '@/utils';

import { RowSidePanelContext } from './DBRowSidePanel';

function filterObjectRecursively(obj: any, filter: string): any {
  if (typeof obj !== 'object' || obj === null || filter === '') {
    return obj;
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) {
      continue;
    }
    if (
      key.toLowerCase().includes(filter.toLowerCase()) ||
      (typeof value === 'string' &&
        value.toLowerCase().includes(filter.toLowerCase()))
    ) {
      result[key] = value;
    }
    if (typeof value === 'object') {
      const v = filterObjectRecursively(value, filter);
      // Skip empty objects
      if (Object.keys(v).length > 0) {
        result[key] = v;
      }
    }
  }

  return result;
}

const viewerOptionsAtom = atomWithStorage('hdx_json_viewer_options', {
  normallyExpanded: true,
  lineWrap: true,
  tabulate: true,
});

function HyperJsonMenu() {
  const [jsonOptions, setJsonOptions] = useAtom(viewerOptionsAtom);

  return (
    <Menu width={240} withinPortal={false}>
      <Menu.Target>
        <ActionIcon size="md" variant="filled" color="gray">
          <i className="bi bi-gear" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label lh={1} py={6}>
          Properties view options
        </Menu.Label>
        <Menu.Item
          onClick={() =>
            setJsonOptions({
              ...jsonOptions,
              normallyExpanded: !jsonOptions.normallyExpanded,
            })
          }
          lh="1"
          py={8}
          rightSection={
            jsonOptions.normallyExpanded ? (
              <i className="ps-2 bi bi-check2" />
            ) : null
          }
        >
          Expand all properties
        </Menu.Item>
        <Menu.Item
          onClick={() =>
            setJsonOptions({
              ...jsonOptions,
              lineWrap: !jsonOptions.lineWrap,
            })
          }
          lh="1"
          py={8}
          rightSection={
            jsonOptions.lineWrap ? <i className="ps-2 bi bi-check2" /> : null
          }
        >
          Preserve line breaks
        </Menu.Item>
        <Menu.Item
          lh="1"
          py={8}
          rightSection={
            jsonOptions.tabulate ? <i className="ps-2 bi bi-check2" /> : null
          }
          onClick={() =>
            setJsonOptions({
              ...jsonOptions,
              tabulate: !jsonOptions.tabulate,
            })
          }
        >
          Tabulate
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

// removeLuceneField('a:x -b:y c:z', "b", "y")  // 返回 'a:x c:z'
// removeLuceneField('a:"x" -a:x', "a", "x")    // 返回 'a:"x"'
// removeLuceneField("  a:x -b:y  ", "c", "z")  // 原样返回，因为 c 不存在
function removeLuceneField(
  query: string,
  key: string,
  valueToRemove: string,
): string {
  if (typeof query !== 'string') return query;

  const regex = new RegExp(
    `(^|\\s)(-?)${escapeRegExp(key)}:(["']?)${escapeRegExp(valueToRemove)}\\3(?=\\s|$)`,
    'i',
  );

  // 直接替换，未匹配时replace()会自动返回原字符串
  const result = query.replace(
    regex,
    (match, leadingSpace) => leadingSpace || '',
  );

  return result; // 天然满足"未匹配时原样返回"
}

// 辅助函数：转义正则特殊字符
function escapeRegExp(str: string): string {
  if (typeof str !== 'string') {
    return String(str);
  }
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

//console.log(removeSqlField("name = 'Alice' OR name != 'Bob' AND age = 25", 'name', "'Bob'"));
// 输出: "name = 'Alice' AND age = 25" （仅删除 name != 'Bob'）
//console.log(removeSqlField("  name = 'Alice'   AND   AND   age = 25  ", 'name', "'Charlie'"));
// 输出: "  name = 'Alice'   AND   AND   age = 25  " （未匹配，原样返回）
function removeSqlField(
  sqlWhere: string,
  key: string,
  valueToRemove: string,
): string {
  if (!sqlWhere || typeof sqlWhere !== 'string') return '';
  if (typeof key !== 'string' || typeof valueToRemove !== 'string')
    return sqlWhere;

  // 转义正则特殊字符
  const escapedValue = escapeRegExp(valueToRemove);

  // 构建正则表达式，支持 = 和 !=
  const exactMatchRegex = new RegExp(
    `(?:\\b(AND|OR)\\s+)?\\b${escapeRegExp(key)}\\s*(!?=)\\s*('${escapedValue}'|"${escapedValue}"|\\b${escapedValue}\\b)(?=(\\s+(?:AND|OR)|\\s*$))`,
    'gi',
  );

  // 检查是否存在匹配项
  if (!exactMatchRegex.test(sqlWhere)) {
    return sqlWhere; // 未找到匹配，原样返回
  }

  // 执行替换（保留操作符前的逻辑运算符 AND/OR）
  let result = sqlWhere.replace(
    exactMatchRegex,
    (match, logicOp, operator, value) => {
      // 如果匹配到的是 AND/OR，保留它（避免破坏 SQL 结构）
      return logicOp ? '' : '';
    },
  );

  // 清理残留的逻辑运算符
  result = result
    .replace(/^\s*(AND|OR)\s*/i, '') // 开头的 AND/OR
    .replace(/\s*(AND|OR)\s*$/i, '') // 结尾的 AND/OR
    .replace(/\s+(AND|OR)\s+(AND|OR)\s+/gi, ' $1 ') // 连续的 AND/OR
    .trim();

  return result || '';
}

export function DBRowJsonViewer({
  data,
  jsonColumns = [],
  compact = false,
}: {
  data: any;
  jsonColumns?: string[];
  compact?: boolean;
}) {
  const {
    onPropertyAddClick,
    generateSearchUrl,
    generateChartUrl,
    displayedColumns,
    toggleColumn,
  } = useContext(RowSidePanelContext);

  const [filter, setFilter] = useState<string>('');
  const [debouncedFilter] = useDebouncedValue(filter, 100);

  const rowData = useMemo(() => {
    if (!data) {
      return null;
    }

    // remove internal aliases (keys that start with __hdx_)
    Object.keys(data).forEach(key => {
      if (key.startsWith('__hdx_')) {
        delete data[key];
      }
    });

    return filterObjectRecursively(data, debouncedFilter);
  }, [data, debouncedFilter]);

  const searchParams = useSearchParams();

  const getLineActions = useCallback<GetLineActions>(
    ({ keyPath, value }) => {
      const actions: LineAction[] = [];
      let fieldPath = mergePath(keyPath);
      const isJsonColumn =
        keyPath.length > 0 && jsonColumns?.includes(keyPath[0]);

      if (isJsonColumn) {
        fieldPath = keyPath.join('.');
        if (keyPath.length > 1) {
          fieldPath = `${keyPath[0]}.${keyPath
            .slice(1)
            .map(k => `\`${k}\``)
            .join('.')}`;
        }
      }

      let luceneFieldPath = '';
      if (compact) {
        // 对于扁平化的 resourceAttributes，使用 ResourceAttributes['fieldName'] 格式
        fieldPath = `ResourceAttributes['${keyPath}']`;
        luceneFieldPath = `ResourceAttributes.${keyPath}`;
      } else {
        luceneFieldPath = keyPath.join('.');
      }

      let where = searchParams.get('where') || '';
      let whereLanguage = searchParams.get('whereLanguage');
      if (whereLanguage == '') {
        // 默认是 lucene
        whereLanguage = 'lucene';
      }

      let removedFilterWhere = ''; // 已经移除过 filter 的 where
      let hadFilter = false;
      if (where !== '') {
        // 如果已经有了 where，判断是否已经有了对应的 filter，如果没有，则添加连接符
        if (whereLanguage === 'sql') {
          removedFilterWhere = removeSqlField(where, fieldPath, value);
          hadFilter = removedFilterWhere !== where;
          if (!hadFilter) {
            where += ' AND ';
          }
        } else {
          removedFilterWhere = removeLuceneField(where, luceneFieldPath, value);
          hadFilter = removedFilterWhere !== where;
          if (!hadFilter) {
            where += ' ';
          }
        }
      }

      if (generateSearchUrl && typeof value !== 'object' && hadFilter) {
        actions.push({
          key: 'remove-filter',
          label: (
            <>
              <i className="bi bi-x-circle me-1" />
              Remove Filter
            </>
          ),
          onClick: () => {
            router.push(
              generateSearchUrl({
                where: removedFilterWhere,
                whereLanguage: whereLanguage as 'sql' | 'lucene',
              }),
            );
          },
        });
      }

      if (generateSearchUrl && typeof value !== 'object' && !hadFilter) {
        actions.push({
          key: 'filter',
          label: (
            <>
              <i className="bi bi-search me-1" />
              Filter
            </>
          ),
          title: 'Add to Filters',
          onClick: () => {
            if (whereLanguage === 'lucene') {
              where += `${luceneFieldPath}:"${value}"`;
            } else {
              where += `${fieldPath} = ${
                typeof value === 'string' ? `'${value}'` : value
              }`;
            }

            router.push(
              generateSearchUrl({
                where: where,
                whereLanguage: whereLanguage as 'sql' | 'lucene',
              }),
            );
          },
        });
      }

      if (generateSearchUrl && typeof value !== 'object' && !hadFilter) {
        actions.push({
          key: 'exclude',
          label: (
            <>
              <i className="bi bi-dash-circle me-1" />
              Exclude
            </>
          ),
          title: 'Exclude from Filters',
          onClick: () => {
            if (whereLanguage === 'lucene') {
              where += `-${luceneFieldPath}:"${value}"`;
            } else {
              where += `${fieldPath} != ${
                typeof value === 'string' ? `'${value}'` : value
              }`;
            }

            router.push(
              generateSearchUrl({
                where: where,
                whereLanguage: whereLanguage as 'sql' | 'lucene',
              }),
            );
          },
        });
      }

      if (generateSearchUrl && typeof value !== 'object' && !hadFilter) {
        actions.push({
          key: 'replace-filter',
          label: (
            <>
              <i className="bi bi-arrow-counterclockwise me-1" />
              Replace Filter
            </>
          ),
          title: 'Search for this value only',
          onClick: () => {
            where = '';
            if (whereLanguage === 'lucene') {
              where = `${luceneFieldPath}:"${value}"`;
            } else {
              where = `${fieldPath} = ${
                typeof value === 'string' ? `'${value}'` : value
              }`;
            }

            router.push(
              generateSearchUrl({
                where: where,
                whereLanguage: whereLanguage as 'sql' | 'lucene',
              }),
            );
          },
        });
      }

      /* TODO: Handle bools properly (they show up as number...) */
      if (generateChartUrl && typeof value === 'number') {
        actions.push({
          key: 'chart',
          label: <i className="bi bi-graph-up" />,
          title: 'Chart',
          onClick: () => {
            router.push(
              generateChartUrl({
                aggFn: 'avg',
                field: fieldPath,
                groupBy: [],
              }),
            );
          },
        });
      }

      // Toggle column action (non-object values)
      if (toggleColumn && typeof value !== 'object') {
        const isIncluded = displayedColumns?.includes(fieldPath);
        actions.push({
          key: 'toggle-column',
          label: isIncluded ? (
            <>
              <i className="bi bi-dash fs-7 me-1" />
              Column
            </>
          ) : (
            <>
              <i className="bi bi-plus fs-7 me-1" />
              Column
            </>
          ),
          title: isIncluded
            ? `Remove ${fieldPath} column from results table`
            : `Add ${fieldPath} column to results table`,
          onClick: () => {
            toggleColumn(fieldPath);
            notifications.show({
              color: 'green',
              message: `Column "${fieldPath}" ${
                isIncluded ? 'removed from' : 'added to'
              } results table`,
            });
          },
        });
      }

      const handleCopyObject = () => {
        const copiedObj =
          keyPath.length === 0 ? rowData : get(rowData, keyPath);
        window.navigator.clipboard.writeText(
          JSON.stringify(copiedObj, null, 2),
        );
        notifications.show({
          color: 'green',
          message: `Copied object to clipboard`,
        });
      };

      if (typeof value === 'object') {
        actions.push({
          key: 'copy-object',
          label: (
            <>
              <i className="bi bi-clipboard me-1" />
              Copy Object
            </>
          ),
          onClick: handleCopyObject,
        });
      } else {
        actions.push({
          key: 'copy-value',
          label: (
            <>
              <i className="bi bi-copy me-1" />
              Copy Value
            </>
          ),
          onClick: () => {
            window.navigator.clipboard.writeText(
              typeof value === 'string'
                ? value
                : JSON.stringify(value, null, 2),
            );
            notifications.show({
              color: 'green',
              message: `Value copied to clipboard`,
            });
          },
        });
      }

      return actions;
    },
    [
      jsonColumns,
      searchParams,
      generateSearchUrl,
      generateChartUrl,
      toggleColumn,
      displayedColumns,
      rowData,
    ],
  );

  const jsonOptions = useAtomValue(viewerOptionsAtom);

  // 紧凑模式：使用 Flex 布局显示扁平化的键值对
  const flattenedData = useMemo(() => {
    if (!compact || !rowData || typeof rowData !== 'object') return [];

    const result: Array<{ key: string; value: any; keyPath: string[] }> = [];

    const flattenObject = (obj: any, prefix: string[] = []) => {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = [...prefix, key];
        if (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value)
        ) {
          flattenObject(value, currentPath);
        } else {
          result.push({
            key,
            value,
            keyPath: currentPath,
          });
        }
      }
    };

    flattenObject(rowData);
    return result;
  }, [compact, rowData]);

  if (compact) {
    return (
      <div className="flex-grow-1 bg-body overflow-auto">
        <Flex wrap="wrap" gap="2px" mx="md" mb="lg">
          {flattenedData.map(({ key, value, keyPath }) => {
            const actions = getLineActions({ keyPath, value, key });
            const hasActions = actions.length > 0;

            return (
              <Menu
                key={`${keyPath.join('.')}-${value}`}
                position="bottom-start"
                withinPortal={false}
              >
                <Menu.Target>
                  <div
                    className={`text-muted-hover bg-hdx-dark px-2 py-0.5 me-1 my-1 ${
                      hasActions ? 'cursor-pointer' : ''
                    }`}
                  >
                    {key}: {String(value)}
                  </div>
                </Menu.Target>
                {hasActions && (
                  <Menu.Dropdown>
                    {actions.map(action => (
                      <Menu.Item
                        key={action.key}
                        leftSection={action.label}
                        onClick={action.onClick}
                      >
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                )}
              </Menu>
            );
          })}
        </Flex>
      </div>
    );
  }

  return (
    <div className="flex-grow-1 bg-body overflow-auto">
      <Box py="xs">
        <Group gap="xs">
          <Input
            size="xs"
            w="100%"
            maw="400px"
            placeholder="Search properties by key or value"
            value={filter}
            onChange={e => setFilter(e.currentTarget.value)}
            leftSection={<i className="bi bi-search" />}
          />
          {filter && (
            <Button
              variant="filled"
              color="gray"
              size="xs"
              onClick={() => setFilter('')}
            >
              Clear
            </Button>
          )}
          <div className="flex-grow-1" />
          <HyperJsonMenu />
        </Group>
      </Box>
      <Paper bg="transparent" mt="sm">
        {rowData != null ? (
          <HyperJson
            data={rowData}
            getLineActions={getLineActions}
            {...jsonOptions}
          />
        ) : (
          <Text>No data</Text>
        )}
      </Paper>
    </div>
  );
}
