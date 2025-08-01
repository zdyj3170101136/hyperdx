import { useEffect, useMemo, useState } from 'react';
import { Field, TableConnection } from '@hyperdx/common-utils/dist/metadata';
import { ChartConfigWithDateRange } from '@hyperdx/common-utils/dist/types';

import {
  deduplicate2dArray,
  useAllFields,
  useGetKeyValues,
} from '@/hooks/useMetadata';
import { toArray } from '@/utils';

export interface ILanguageFormatter {
  formatFieldValue: (f: Field) => string;
  formatFieldLabel: (f: Field) => string;
  formatKeyValPair: (key: string, value: string) => string;
}

export function useAutoCompleteOptions(
  formatter: ILanguageFormatter,
  value: string,
  {
    tableConnections,
    additionalSuggestions,
    // 此处默认传一个值，仅是为了符合 ChartConfigWithDateRange 的类型
    // 实际上不会被用到
    dateRange = [new Date('2024-01-01'), new Date('2024-12-31')],
    timestampValueExpression = '',
  }: {
    tableConnections?: TableConnection | TableConnection[];
    additionalSuggestions?: string[];
    dateRange?: [Date, Date];
    timestampValueExpression?: string;
  },
) {
  // 判断是在搜索列名还是列值
  // 如果最后一个 token 有 :，则在搜索列值。
  // 否则是在搜索列名。
  // 例如 kubernetes.pod.name:"service" level:abc 搜索列 level 的值
  // 例如 kubernetes.pod.name:"service" lev 搜索包含列 lev 的列名
  const tokens = value.split(' ');
  const lastToken = tokens[tokens.length - 1];
  const isSearchColumeValue = lastToken.endsWith(':');
  // key 表示是哪个列要搜索列值
  const key = lastToken.substring(0, lastToken.indexOf(':') + 1);

  // 将搜索条件都放进 chartConfigs 中
  const chartConfigsSearchColume: ChartConfigWithDateRange[] = toArray(
    tableConnections,
  ).map(({ databaseName, tableName, connectionId }) => ({
    connection: connectionId,
    from: {
      databaseName,
      tableName,
    },
    timestampValueExpression: timestampValueExpression,
    select: '',
    whereLanguage: 'lucene',
    // 如果 value 是 a:b level:x 的形式，不是在搜索列名。
    // 如果 value 是 a:b lev 的形式，将 a:b 作为搜索条件。
    // TODO 目前只支持 mapKeys 的搜索，添加 keyname ilike '%lev%' 的搜索。
    where: isSearchColumeValue ? '' : removeAfterLastSpace(value),
    // 使用日志查询的时间范围获取 key,value
    // fix https://github.com/hyperdxio/hyperdx/issues/974
    dateRange: dateRange,
    implicitColumnExpression: 'Body',
  }));

  // Fetch and gather all field options
  const { data: fields } = useAllFields(
    tableConnections ?? [],
    {
      enabled:
        !!tableConnections &&
        (Array.isArray(tableConnections) ? tableConnections.length > 0 : true),
    },
    chartConfigsSearchColume,
  );
  const { fieldCompleteOptions, fieldCompleteMap } = useMemo(() => {
    const _columns = (fields ?? []).filter(c => c.jsType !== null);

    const fieldCompleteMap = new Map<string, Field>();
    const baseOptions = _columns.map(c => {
      const val = {
        value: formatter.formatFieldValue(c),
        label: formatter.formatFieldLabel(c),
      };
      fieldCompleteMap.set(val.value, c);
      return val;
    });

    const suggestionOptions =
      additionalSuggestions?.map(column => ({
        value: column,
        label: column,
      })) ?? [];

    const fieldCompleteOptions = [...baseOptions, ...suggestionOptions];

    return { fieldCompleteOptions, fieldCompleteMap };
  }, [formatter, fields, additionalSuggestions]);

  // searchField is used for the purpose of checking if a key is valid and key values should be fetched
  const [searchField, setSearchField] = useState<Field | null>(null);
  // check if any search field matches
  useEffect(() => {
    const v = fieldCompleteMap.get(key);
    if (v) {
      setSearchField(v);
    }
  }, [fieldCompleteMap, key]);
  // clear search field if no key matches anymore
  useEffect(() => {
    if (!searchField) return;
    if (!key.startsWith(formatter.formatFieldValue(searchField))) {
      setSearchField(null);
    }
  }, [searchField, setSearchField, key, formatter]);
  const searchKeys = useMemo(
    () =>
      searchField
        ? [
            searchField.path.length > 1
              ? `${searchField.path[0]}['${searchField.path[1]}']`
              : searchField.path[0],
          ]
        : [],
    [searchField],
  );

  // hooks to get key values
  const chartConfigsSearchColumeValue: ChartConfigWithDateRange[] = toArray(
    tableConnections,
  ).map(({ databaseName, tableName, connectionId }) => ({
    connection: connectionId,
    from: {
      databaseName,
      tableName,
    },
    timestampValueExpression: timestampValueExpression,
    select: '',
    whereLanguage: 'lucene',
    // 如果 value 是 a:b level: 的形式，将 a:b 作为搜索条件。
    // 如果 value 是 a:b level:c 的形式，将 value 作为搜索条件。
    where: value?.endsWith(':') ? removeAfterLastSpace(value) : value,
    // 使用日志查询的时间范围获取 key,value
    // fix https://github.com/hyperdxio/hyperdx/issues/974
    dateRange: dateRange,
    implicitColumnExpression: 'Body',
  }));
  const { data: keyVals } = useGetKeyValues({
    chartConfigs: chartConfigsSearchColumeValue,
    keys: searchKeys,
    limit: 10, // 避免使用默认的 20 个 limit，因为 suggestion 下拉框只展示十个。
  });
  const keyValCompleteOptions = useMemo<
    { value: string; label: string }[]
  >(() => {
    if (!keyVals || !searchField) return fieldCompleteOptions;
    const output = // TODO: Fix this hacky type assertion caused by bug in HDX-1548
      (
        keyVals as unknown as {
          key: string;
          value: (string | { [key: string]: string })[];
        }[]
      ).flatMap(kv => {
        return kv.value.flatMap(v => {
          if (typeof v === 'string') {
            const value = formatter.formatKeyValPair(
              formatter.formatFieldValue(searchField),
              v,
            );
            return [
              {
                value,
                label: value,
              },
            ];
          } else if (typeof v === 'object') {
            // TODO: Fix type issues mentioned in HDX-1548
            const output: {
              value: string;
              label: string;
            }[] = [];
            for (const [key, val] of Object.entries(v)) {
              if (typeof key !== 'string' || typeof val !== 'string') {
                console.error('unknown type for autocomplete object ', v);
                return [];
              }
              const field = structuredClone(searchField);
              field.path.push(key);
              const value = formatter.formatKeyValPair(
                formatter.formatFieldValue(field),
                val,
              );
              output.push({
                value,
                label: value,
              });
            }
            return output;
          } else {
            return [];
          }
        });
      });
    return output;
  }, [fieldCompleteOptions, keyVals, searchField]);

  // combine all autocomplete options
  return useMemo(() => {
    return deduplicate2dArray([fieldCompleteOptions, keyValCompleteOptions]);
  }, [fieldCompleteOptions, keyValCompleteOptions]);
}

function removeAfterLastSpace(value: string): string {
  const lastSpaceIndex = value.lastIndexOf(' ');
  if (lastSpaceIndex === -1) {
    return ''; // 没有空格，返回整个字符串
  }
  return value.substring(0, value.lastIndexOf(' '));
}
