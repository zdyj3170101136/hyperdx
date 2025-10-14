import { useCallback, useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import router from 'next/router';
import { useAtom, useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import get from 'lodash/get';
import lucene from '@hyperdx/lucene';
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

// value 为空时，删除所有符合 key 的节点
// value 不为空时，删除符合 key 和 value 的节点
// keep 为 true 的时候，保留符合条件的 node；否则删除
// modified 表示是否有移除
function rangeNodesWithKey(
  ast: any,
  key: string,
  value: string,
  keep: boolean,
): { result: any; modified: boolean } {
  if (!ast) return { result: null, modified: false };

  // 如果是叶子节点（term）
  if (ast.term) {
    let matched = false;
    // 如果这个节点的 field 匹配要删除的 key，返回 null
    if (ast.field === key || ast.field === `-${key}`) {
      if (value !== '') {
        if (ast.term === value) {
          matched = true;
        }
      } else {
        matched = true;
      }
    }
    if ((matched && keep) || (!matched && !keep)) {
      return { result: ast, modified: false };
    } else {
      return { result: null, modified: true };
    }
  }

  // 如果是操作符节点
  const leftResult = rangeNodesWithKey(ast.left, key, value, keep);
  const rightResult = rangeNodesWithKey(ast.right, key, value, keep);
  const left = leftResult.result;
  const right = rightResult.result;
  const modified = leftResult.modified || rightResult.modified;

  // 如果左右节点都被删除了，返回 null
  if (!left && !right) {
    return { result: null, modified: modified };
  }

  // 如果只有左节点被删除，返回右节点
  if (!left && right) {
    return { result: right, modified: modified };
  }

  // 如果只有右节点被删除，返回左节点
  if (left && !right) {
    return { result: left, modified: modified };
  }

  // 如果两个节点都存在，返回原结构
  return {
    result: {
      ...ast,
      left,
      right,
    },
    modified,
  };
}

export function removeLuceneField(
  query: string,
  key: string,
  value: string,
): { result: string; modified: boolean } {
  if (typeof query !== 'string') return { result: query, modified: false };

  try {
    // 使用 AST 方法删除指定 key 的节点
    const ast = lucene.parse(query);
    const { result: modifiedAst, modified } = rangeNodesWithKey(
      ast,
      key,
      value,
      false,
    );

    // 如果整个 AST 都被删除了，返回空字符串
    if (!modifiedAst) {
      return { result: '', modified: modified };
    }

    // 将修改后的 AST 转换回查询字符串
    const modifiedString = lucene.toString(modifiedAst);
    return { result: modifiedString, modified };
  } catch (error) {
    // 如果解析失败，回退到原来的正则表达式方法
    console.warn('Failed to parse Lucene query', error);

    return { result: query, modified: false };
  }
}

// 只保留指定 key 的 filter，移除其他所有字段
export function keepOnlyLuceneField(
  query: string,
  keyToKeep: string,
): { result: string } {
  if (typeof query !== 'string') return { result: '' };

  try {
    const ast = lucene.parse(query);
    const { result: filteredAst } = rangeNodesWithKey(ast, keyToKeep, '', true);

    // 如果所有的都被删除了
    if (!filteredAst) {
      return { result: '' };
    }

    // 将修改后的 AST 转换回查询字符串
    const resultString = lucene.toString(filteredAst);
    return { result: resultString };
  } catch (error) {
    console.warn('Failed to parse Lucene query', error);
    return { result: '' };
  }
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
        where += ' AND ';
        // 判断是否已经有了对应的 filter，如果没有，则添加连接符
        if (whereLanguage === 'lucene') {
          const { result, modified } = removeLuceneField(
            where,
            luceneFieldPath,
            value,
          );
          removedFilterWhere = result;
          hadFilter = modified;
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
                      ></Menu.Item>
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
