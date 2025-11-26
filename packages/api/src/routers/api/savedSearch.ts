import { SavedSearchSchema } from '@hyperdx/common-utils/dist/types';
import express from 'express';
import _ from 'lodash';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import {
  createSavedSearch,
  deleteSavedSearch,
  getSavedSearch,
  getSavedSearches,
  updateSavedSearch,
} from '@/controllers/savedSearch';
import { getNonNullUserWithTeam } from '@/middleware/auth';
import { objectIdSchema } from '@/utils/zod';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req);

    // Parse pagination parameters
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const { data, total } = await getSavedSearches(teamId.toString(), {
      limit,
      skip,
    });

    return res.json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/',
  validateRequest({
    body: SavedSearchSchema.omit({ id: true }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);

      const savedSearch = await createSavedSearch(teamId.toString(), req.body);

      return res.json(savedSearch);
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  '/:id',
  validateRequest({
    body: SavedSearchSchema.partial(),
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);

      const savedSearch = await getSavedSearch(
        teamId.toString(),
        req.params.id,
      );

      if (!savedSearch) {
        res.status(404).send('Saved search not found');
        return;
      }

      const updates = _.omitBy(req.body, _.isNil);

      const updatedSavedSearch = await updateSavedSearch(
        teamId.toString(),
        req.params.id,
        {
          ...savedSearch.toJSON(),
          source: savedSearch.source.toString(),
          ...updates,
        },
      );

      if (!updatedSavedSearch) {
        res.status(404).send('Saved search not found');
        return;
      }

      return res.json(updatedSavedSearch);
    } catch (e) {
      next(e);
    }
  },
);

router.delete(
  '/:id',
  validateRequest({ params: z.object({ id: objectIdSchema }) }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);

      await deleteSavedSearch(teamId.toString(), req.params.id);

      return res.status(204).send();
    } catch (e) {
      next(e);
    }
  },
);

export default router;
