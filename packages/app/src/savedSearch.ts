import { SavedSearch } from '@hyperdx/common-utils/dist/types';
import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryOptions,
} from '@tanstack/react-query';

import { hdxServer } from './api';
import { IS_LOCAL_MODE } from './config';

type SavedSearchesResponse = {
  data: SavedSearch[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export function useSavedSearches(
  page: number = 1,
  limit: number = 10,
  search?: string | null,
) {
  return useQuery({
    queryKey: ['saved-search', page, limit, search],
    queryFn: async () => {
      if (IS_LOCAL_MODE) {
        return { data: [], pagination: undefined };
      } else {
        const params = new URLSearchParams({
          page: page.toString(),
          limit: limit.toString(),
        });
        if (search) {
          params.append('q', search);
        }
        return hdxServer(
          `saved-search?${params.toString()}`,
        ).json<SavedSearchesResponse>();
      }
    },
  });
}

export function useSavedSearch(
  { id }: { id: string },
  options: Omit<Partial<UseQueryOptions<SavedSearch[], Error>>, 'select'> = {},
) {
  return useQuery({
    queryKey: ['saved-search'],
    queryFn: () => {
      if (IS_LOCAL_MODE) {
        return [];
      }
      return hdxServer('saved-search').json<SavedSearch[]>();
    },
    select: data => data.find(s => s.id === id),
    ...options,
  });
}

export function useCreateSavedSearch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Omit<SavedSearch, 'id'>) => {
      return hdxServer('saved-search', {
        method: 'POST',
        json: data,
      }).json<SavedSearch>();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-search'] });
    },
  });
}

export function useUpdateSavedSearch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<SavedSearch> & { id: SavedSearch['id'] }) => {
      return hdxServer(`saved-search/${data.id}`, {
        method: 'PATCH',
        json: data,
      }).json<SavedSearch>();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-search'] });
    },
  });
}

export function useDeleteSavedSearch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => {
      return hdxServer(`saved-search/${id}`, { method: 'DELETE' }).json<void>();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-search'] });
    },
  });
}
