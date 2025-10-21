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
import { objectIdSchema } from '@/utils/zod';

/**
 * @openapi
 * components:
 *   schemas:
 *     SavedSearch:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           example: "65f5e4a3b9e77c001a123456"
 *         name:
 *           type: string
 *           example: "Error Logs"
 *         select:
 *           type: string
 *           example: "Timestamp, ServiceName, SeverityText, Body"
 *         where:
 *           type: string
 *           example: "SeverityText:error"
 *         whereLanguage:
 *           type: string
 *           enum: [sql, lucene]
 *           example: "lucene"
 *         source:
 *           type: string
 *           example: "679b12d6cf282580fc63aad4"
 *         orderBy:
 *           type: string
 *           example: "TimestampTime DESC"
 *         tags:
 *           type: array
 *           items:
 *             type: string
 *           example: ["error", "production"]
 *         createdAt:
 *           type: string
 *           format: date-time
 *           example: "2024-01-01T00:00:00.000Z"
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           example: "2024-01-01T00:00:00.000Z"
 *
 *     CreateSavedSearchRequest:
 *       type: object
 *       required:
 *         - name
 *         - select
 *         - where
 *         - source
 *       properties:
 *         name:
 *           type: string
 *           example: "Error Logs"
 *         select:
 *           type: string
 *           example: "Timestamp, ServiceName, SeverityText, Body"
 *         where:
 *           type: string
 *           example: "SeverityText:error"
 *         whereLanguage:
 *           type: string
 *           enum: [sql, lucene]
 *           example: "lucene"
 *         source:
 *           type: string
 *           example: "679b12d6cf282580fc63aad4"
 *         orderBy:
 *           type: string
 *           example: "TimestampTime DESC"
 *         tags:
 *           type: array
 *           items:
 *             type: string
 *           example: ["error", "production"]
 *
 *     UpdateSavedSearchRequest:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           example: "Updated Error Logs"
 *         select:
 *           type: string
 *           example: "Timestamp, ServiceName, SeverityText, Body, RequestId"
 *         where:
 *           type: string
 *           example: "SeverityText:error AND ServiceName:api"
 *         whereLanguage:
 *           type: string
 *           enum: [sql, lucene]
 *           example: "lucene"
 *         source:
 *           type: string
 *           example: "679b12d6cf282580fc63aad4"
 *         orderBy:
 *           type: string
 *           example: "TimestampTime DESC"
 *         tags:
 *           type: array
 *           items:
 *             type: string
 *           example: ["error", "api", "production"]
 *
 *     SavedSearchResponse:
 *       type: object
 *       properties:
 *         data:
 *           $ref: '#/components/schemas/SavedSearch'
 *
 *     SavedSearchListResponse:
 *       type: object
 *       properties:
 *         data:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/SavedSearch'
 *
 *     EmptyResponse:
 *       type: object
 *       properties: {}
 */

const router = express.Router();

/**
 * @openapi
 * /api/v2/saved-search:
 *   get:
 *     summary: List Saved Searches
 *     description: Retrieves a list of all saved searches for the authenticated team
 *     operationId: listSavedSearches
 *     tags: [SavedSearch]
 *     responses:
 *       '200':
 *         description: Successfully retrieved saved searches
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SavedSearchListResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/', async (req, res, next) => {
  try {
    const teamId = req.user?.team;
    if (teamId == null) {
      return res.sendStatus(403);
    }

    const savedSearches = await getSavedSearches(teamId.toString());

    return res.json({
      data: savedSearches,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * @openapi
 * /api/v2/saved-search:
 *   post:
 *     summary: Create Saved Search
 *     description: Creates a new saved search
 *     operationId: createSavedSearch
 *     tags: [SavedSearch]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateSavedSearchRequest'
 *           examples:
 *             errorLogs:
 *               summary: Create an error logs saved search
 *               value:
 *                 name: "Error Logs"
 *                 select: "Timestamp, ServiceName, SeverityText, Body"
 *                 where: "SeverityText:error"
 *                 whereLanguage: "lucene"
 *                 source: "679b12d6cf282580fc63aad4"
 *                 orderBy: "TimestampTime DESC"
 *                 tags: ["error", "production"]
 *     responses:
 *       '200':
 *         description: Successfully created saved search
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SavedSearchResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '500':
 *         description: Server error or validation failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post(
  '/',
  validateRequest({
    body: SavedSearchSchema.omit({ id: true }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }

      const savedSearch = await createSavedSearch(teamId.toString(), req.body);

      return res.json({
        data: savedSearch,
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * @openapi
 * /api/v2/saved-search/{id}:
 *   get:
 *     summary: Get Saved Search
 *     description: Retrieves a specific saved search by ID
 *     operationId: getSavedSearch
 *     tags: [SavedSearch]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Saved Search ID
 *         example: "65f5e4a3b9e77c001a123456"
 *     responses:
 *       '200':
 *         description: Successfully retrieved saved search
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SavedSearchResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '404':
 *         description: Saved search not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  '/:id',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }

      const savedSearch = await getSavedSearch(
        teamId.toString(),
        req.params.id,
      );

      if (!savedSearch) {
        return res.sendStatus(404);
      }

      return res.json({
        data: savedSearch,
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * @openapi
 * /api/v2/saved-search/{id}:
 *   put:
 *     summary: Update Saved Search
 *     description: Updates an existing saved search
 *     operationId: updateSavedSearch
 *     tags: [SavedSearch]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Saved Search ID
 *         example: "65f5e4a3b9e77c001a123456"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateSavedSearchRequest'
 *           examples:
 *             updateSearch:
 *               summary: Update saved search properties
 *               value:
 *                 name: "Updated Error Logs"
 *                 select: "Timestamp, ServiceName, SeverityText, Body, RequestId"
 *                 where: "SeverityText:error AND ServiceName:api"
 *                 tags: ["error", "api", "production"]
 *     responses:
 *       '200':
 *         description: Successfully updated saved search
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SavedSearchResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '404':
 *         description: Saved search not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '500':
 *         description: Server error or validation failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put(
  '/:id',
  validateRequest({
    body: SavedSearchSchema.partial(),
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }

      const savedSearch = await getSavedSearch(
        teamId.toString(),
        req.params.id,
      );

      if (!savedSearch) {
        return res.sendStatus(404);
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
        return res.sendStatus(404);
      }

      return res.json({
        data: updatedSavedSearch,
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * @openapi
 * /api/v2/saved-search/{id}:
 *   delete:
 *     summary: Delete Saved Search
 *     description: Deletes a saved search
 *     operationId: deleteSavedSearch
 *     tags: [SavedSearch]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Saved Search ID
 *         example: "65f5e4a3b9e77c001a123456"
 *     responses:
 *       '200':
 *         description: Successfully deleted saved search
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmptyResponse'
 *             example: {}
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '404':
 *         description: Saved search not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete(
  '/:id',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }

      const savedSearch = await getSavedSearch(
        teamId.toString(),
        req.params.id,
      );

      if (!savedSearch) {
        return res.sendStatus(404);
      }

      await deleteSavedSearch(teamId.toString(), req.params.id);
      res.sendStatus(200);
    } catch (e) {
      next(e);
    }
  },
);

export default router;
