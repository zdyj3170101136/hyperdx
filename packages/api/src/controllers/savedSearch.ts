import { SavedSearchSchema } from '@hyperdx/common-utils/dist/types';
import { groupBy } from 'lodash';
import { z } from 'zod';

import { deleteSavedSearchAlerts } from '@/controllers/alerts';
import Alert from '@/models/alert';
import { SavedSearch } from '@/models/savedSearch';

type SavedSearchWithoutId = Omit<z.infer<typeof SavedSearchSchema>, 'id'>;

export async function getSavedSearches(
  teamId: string,
  options?: {
    limit?: number;
    skip?: number;
  },
) {
  const queryFilter: any = { team: teamId };
  const total = await SavedSearch.countDocuments(queryFilter);

  let query = SavedSearch.find(queryFilter);

  // Apply pagination
  if (options?.limit !== undefined) {
    query = query.limit(options.limit);
  }
  if (options?.skip !== undefined) {
    query = query.skip(options.skip);
  }

  // Sort by updatedAt descending (most recently updated first)
  query = query.sort({ updatedAt: -1 });

  const savedSearches = await query;

  // Get alerts for the returned saved searches only (more efficient)
  const savedSearchIds = savedSearches.map(ss => ss._id);
  const alerts = await Alert.find(
    {
      team: teamId,
      savedSearch: { $in: savedSearchIds },
    },
    { __v: 0 },
  );

  const alertsBySavedSearchId = groupBy(alerts, 'savedSearch');

  const data = savedSearches.map(savedSearch => ({
    ...savedSearch.toJSON(),
    alerts: alertsBySavedSearchId[savedSearch._id.toString()]
      ?.map(alert => alert.toJSON())
      .map(({ _id, ...alert }) => ({ id: _id, ...alert })), // Remap _id to id
  }));

  return { data, total };
}

export function getSavedSearch(teamId: string, savedSearchId: string) {
  return SavedSearch.findOne({ _id: savedSearchId, team: teamId });
}

export function createSavedSearch(
  teamId: string,
  savedSearch: SavedSearchWithoutId,
) {
  return SavedSearch.create({ ...savedSearch, team: teamId });
}

export function updateSavedSearch(
  teamId: string,
  savedSearchId: string,
  savedSearch: SavedSearchWithoutId,
) {
  return SavedSearch.findOneAndUpdate(
    { _id: savedSearchId, team: teamId },
    {
      ...savedSearch,
      team: teamId,
    },
    { new: true },
  );
}

export async function deleteSavedSearch(teamId: string, savedSearchId: string) {
  const savedSearch = await SavedSearch.findOneAndDelete({
    _id: savedSearchId,
    team: teamId,
  });
  if (savedSearch) {
    await deleteSavedSearchAlerts(savedSearchId, teamId);
  }
}
