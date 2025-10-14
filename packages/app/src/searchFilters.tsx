import React from 'react';
import produce from 'immer';
import type { Filter } from '@hyperdx/common-utils/dist/types';
import lucene from '@hyperdx/lucene';

import { removeLuceneField } from './components/DBRowJsonViewer';
import { useLocalStorage } from './utils';

export type FilterState = {
  [key: string]: {
    included: Set<string>;
    excluded: Set<string>;
  };
};

export const filtersToQuery = (filters: FilterState): Filter[] => {
  return Object.entries(filters)
    .filter(
      ([_, values]) => values.included.size > 0 || values.excluded.size > 0,
    )
    .flatMap(([key, values]) => {
      const conditions = [];
      if (values.included.size > 0) {
        conditions.push({
          type: 'sql' as const,
          condition: `${key} IN (${Array.from(values.included)
            .map(v => `'${v}'`)
            .join(', ')})`,
        });
      }
      if (values.excluded.size > 0) {
        conditions.push({
          type: 'sql' as const,
          condition: `${key} NOT IN (${Array.from(values.excluded)
            .map(v => `'${v}'`)
            .join(', ')})`,
        });
      }
      return conditions;
    });
};

export const areFiltersEqual = (a: FilterState, b: FilterState) => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    if (!b[key]) return false;

    // Check included values
    if (a[key].included.size !== b[key].included.size) return false;
    for (const value of a[key].included) {
      if (!b[key].included.has(value)) return false;
    }

    // Check excluded values
    if (a[key].excluded.size !== b[key].excluded.size) return false;
    for (const value of a[key].excluded) {
      if (!b[key].excluded.has(value)) return false;
    }
  }

  return true;
};

export const parseQuery = (
  q: Filter[],
): {
  filters: FilterState;
} => {
  const state = new Map<
    string,
    { included: Set<string>; excluded: Set<string> }
  >();
  for (const filter of q) {
    if (filter.type !== 'sql') continue;

    const isExclude = filter.condition.includes('NOT IN');
    const [key, values] = filter.condition.split(
      isExclude ? ' NOT IN ' : ' IN ',
    );
    const keyStr = key.trim();
    const valuesStr = values
      .replace('(', '')
      .replace(')', '')
      .split(',')
      .map(v => v.trim().replace(/'/g, ''));

    if (!state.has(keyStr)) {
      state.set(keyStr, { included: new Set(), excluded: new Set() });
    }
    const sets = state.get(keyStr)!;
    valuesStr.forEach(v => {
      if (isExclude) {
        sets.excluded.add(v);
      } else {
        sets.included.add(v);
      }
    });
  }
  return { filters: Object.fromEntries(state) };
};

// 从 where 参数中提取筛选条件并转换为 FilterState
export const parseWhereToFilters = (
  where: string,
): {
  filters: FilterState;
} => {
  if (!where || where.trim() === '') {
    return { filters: {} };
  }

  try {
    const ast = lucene.parse(where);

    const filters: FilterState = {};

    // 分析 AST 结构
    const keyConditions = analyzeAST(ast);

    // 检查每个 key 的条件是否 parseable
    for (const [key, conditions] of Object.entries(keyConditions)) {
      const included: string[] = [];
      const excluded: string[] = [];

      for (const condition of conditions) {
        const value = condition.term;
        if (condition.field && condition.field.startsWith('-')) {
          excluded.push(value);
        } else {
          included.push(value);
        }
      }

      if (included.length > 0 || excluded.length > 0) {
        // 返回的 filter 中, key 需要移除 - 前缀
        filters[key.startsWith('-') ? key.slice(1) : key] = {
          included: new Set(included),
          excluded: new Set(excluded),
        };
      }
    }

    return { filters };
  } catch (error) {
    // 如果解析失败，返回空结果
    console.warn('Failed to parse Lucene query:', error);
    return { filters: {} };
  }
};

// 分析 AST 结构，提取每个 key 的条件
function analyzeAST(ast: any): Record<string, any[]> {
  const keyConditions: Record<string, any[]> = {};

  function traverse(node: any) {
    if (!node) return;

    // 如果是叶子节点（term）
    if (node.term) {
      if (node.field) {
        if (node.field === '<implicit>') {
          // token。
          return;
        }
        if (!keyConditions[node.field]) {
          keyConditions[node.field] = [];
        }
        keyConditions[node.field].push(node);
      }
      return;
    }
    // 递归处理左右子树
    traverse(node.left);
    traverse(node.right);
  }

  traverse(ast);
  return keyConditions;
}

export type FilterChangeInfo = {
  type: 'added' | 'removed';
  field: string;
  value: string;
  filterType: 'included' | 'excluded';
};

// 检测所有筛选条件的变动
// 比如选中一个 key，然后再点击 exclude
// 会产生两个变动，一个是 delete included，一个是 add excluded
function detectFilterChanges(
  prevFilters: FilterState,
  newFilters: FilterState,
): FilterChangeInfo[] {
  const changes: FilterChangeInfo[] = [];

  // 检查所有字段的变动
  const allFields = new Set([
    ...Object.keys(prevFilters),
    ...Object.keys(newFilters),
  ]);

  for (const field of allFields) {
    const prevFieldFilters = prevFilters[field] || {
      included: new Set(),
      excluded: new Set(),
    };
    const newFieldFilters = newFilters[field] || {
      included: new Set(),
      excluded: new Set(),
    };

    // 检查 included 的变动
    for (const value of prevFieldFilters.included) {
      if (!newFieldFilters.included.has(value)) {
        // 从 included 中移除
        changes.push({
          type: 'removed',
          field,
          value,
          filterType: 'included',
        });
      }
    }

    for (const value of newFieldFilters.included) {
      if (!prevFieldFilters.included.has(value)) {
        // 新增到 included
        changes.push({
          type: 'added',
          field,
          value,
          filterType: 'included',
        });
      }
    }

    // 检查 excluded 的变动
    for (const value of prevFieldFilters.excluded) {
      if (!newFieldFilters.excluded.has(value)) {
        // 从 excluded 中移除
        changes.push({
          type: 'removed',
          field,
          value,
          filterType: 'excluded',
        });
      }
    }

    for (const value of newFieldFilters.excluded) {
      if (!prevFieldFilters.excluded.has(value)) {
        // 新增到 excluded
        changes.push({
          type: 'added',
          field,
          value,
          filterType: 'excluded',
        });
      }
    }
  }

  return changes;
}

export const useSearchPageFilterState = ({
  searchQuery = [],
  onFilterChange,
  where = '',
  onWhereChange,
  whereLanguage = 'lucene',
}: {
  searchQuery?: Filter[];
  onFilterChange: (filters: Filter[]) => void;
  where?: string;
  onWhereChange: (where: string) => void;
  whereLanguage?: string;
}) => {
  const parsedQuery = React.useMemo(() => {
    try {
      return parseQuery(searchQuery);
    } catch (e) {
      console.error(e);
      return { filters: {} };
    }
  }, [searchQuery]);

  // 当查询语法为 lucene 的时候，所有筛选条件都在 where 函数中。
  // 从预处理的 where 参数中提取筛选条件
  const { filters: whereFilters } = React.useMemo(() => {
    try {
      if (whereLanguage === 'lucene') {
        return parseWhereToFilters(where) as { filters: FilterState };
      } else {
        return { filters: {} };
      }
    } catch (e) {
      console.error('Error parsing where to filters:', e);
      return { filters: {} };
    }
  }, [where, whereLanguage]);

  // 根据 whereLanguage 选择使用哪个筛选条件
  const combinedFilters = React.useMemo(() => {
    return whereLanguage === 'lucene' ? whereFilters : parsedQuery.filters;
  }, [whereLanguage, whereFilters, parsedQuery.filters]);

  const [filters, setFilters] = React.useState<FilterState>({});

  React.useEffect(() => {
    if (
      // 不要 check combinedFilters 的长度
      // 例如点击 filter 后，通过行快捷键移除 remove filter，此时就为空。
      !areFiltersEqual(filters, combinedFilters)
    ) {
      setFilters(combinedFilters);
    }
    // only react to changes in combined filters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combinedFilters]);

  const updateFilterQuery = React.useCallback(
    (newFilters: FilterState, prevFilters?: FilterState) => {
      if (whereLanguage === 'lucene') {
        let finalWhere = ''; // 如果 prevFilters 为空，则直接清空
        if (prevFilters) {
          finalWhere = where;
          const changes = detectFilterChanges(prevFilters, newFilters);
          changes.forEach(change => {
            if (change.type === 'removed') {
              finalWhere = removeLuceneField(
                finalWhere,
                change.field,
                change.value,
              ).result;
            } else {
              if (finalWhere !== '') {
                finalWhere += ' AND ';
              }
              if (change.filterType === 'included') {
                finalWhere = finalWhere + `${change.field}:"${change.value}"`;
              } else {
                finalWhere = finalWhere + `-${change.field}:"${change.value}"`;
              }
            }
          });
        }
        onWhereChange(finalWhere);
      } else {
        onFilterChange(filtersToQuery(newFilters));
      }
    },
    [onFilterChange, onWhereChange, where, whereLanguage],
  );

  const setFilterValue = React.useCallback(
    (
      property: string,
      value: string,
      action?: 'only' | 'exclude' | 'include',
    ) => {
      setFilters(prevFilters => {
        const newFilters = produce(prevFilters, draft => {
          if (!draft[property]) {
            draft[property] = { included: new Set(), excluded: new Set() };
          }

          if (action === 'only') {
            draft[property] = {
              included: new Set([value]),
              excluded: new Set(),
            };
            return;
          }

          if (action === 'exclude') {
            // Remove from included if it was there
            draft[property].included.delete(value);
            // Toggle in excluded
            if (draft[property].excluded.has(value)) {
              draft[property].excluded.delete(value);
            } else {
              draft[property].excluded.add(value);
            }
            return;
          }

          // Regular toggle (include)
          draft[property].excluded.delete(value);
          if (draft[property].included.has(value)) {
            draft[property].included.delete(value);
          } else {
            draft[property].included.add(value);
          }
        });

        // 传递 prevFilters 给 updateFilterQuery 以便检测变动
        updateFilterQuery(newFilters, prevFilters);
        return newFilters;
      });
    },
    [updateFilterQuery],
  );

  const clearFilter = React.useCallback(
    (property: string) => {
      setFilters(prevFilters => {
        const newFilters = produce(prevFilters, draft => {
          delete draft[property];
        });
        updateFilterQuery(newFilters, prevFilters);
        return newFilters;
      });
    },
    [updateFilterQuery],
  );

  const clearAllFilters = React.useCallback(() => {
    setFilters(() => ({}));
    updateFilterQuery({});
  }, [updateFilterQuery]);

  return {
    filters,
    setFilters,
    setFilterValue,
    clearFilter,
    clearAllFilters,
  };
};

type PinnedFilters = {
  [key: string]: string[];
};

export type FilterStateHook = ReturnType<typeof useSearchPageFilterState>;

function usePinnedFilterBySource(sourceId: string | null) {
  // Eventually replace pinnedFilters with a GET from api/mongo
  // Eventually replace setPinnedFilters with a POST to api/mongo
  const [_pinnedFilters, _setPinnedFilters] = useLocalStorage<{
    [sourceId: string]: PinnedFilters;
  }>('hdx-pinned-search-filters', {});

  const pinnedFilters = React.useMemo<PinnedFilters>(
    () =>
      !sourceId || !_pinnedFilters[sourceId] ? {} : _pinnedFilters[sourceId],
    [_pinnedFilters, sourceId],
  );
  const setPinnedFilters = React.useCallback<
    (val: PinnedFilters | ((pf: PinnedFilters) => PinnedFilters)) => void
  >(
    val => {
      if (!sourceId) return;
      _setPinnedFilters(prev =>
        produce(prev, draft => {
          draft[sourceId] =
            val instanceof Function ? val(draft[sourceId] ?? {}) : val;
        }),
      );
    },
    [sourceId, _setPinnedFilters],
  );
  return { pinnedFilters, setPinnedFilters };
}

export function usePinnedFilters(sourceId: string | null) {
  const { pinnedFilters, setPinnedFilters } = usePinnedFilterBySource(sourceId);

  const toggleFilterPin = React.useCallback(
    (property: string, value: string) => {
      setPinnedFilters(prevPins =>
        produce(prevPins, draft => {
          if (!draft[property]) {
            draft[property] = [];
          }
          const idx = draft[property].findIndex(v => v === value);
          if (idx >= 0) {
            draft[property].splice(idx);
          } else {
            draft[property].push(value);
          }
          return draft;
        }),
      );
    },
    [setPinnedFilters],
  );

  const isFilterPinned = React.useCallback(
    (property: string, value: string): boolean => {
      return (
        pinnedFilters[property] &&
        pinnedFilters[property].some(v => v === value)
      );
    },
    [pinnedFilters],
  );

  return {
    toggleFilterPin,
    isFilterPinned,
  };
}
