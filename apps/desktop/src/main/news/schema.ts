import { z } from 'zod';
import { NEWS_CATEGORIES, NEWS_SEVERITIES } from '../../shared/newsTypes';

/**
 * What the website API answers, checked before anything is cached. Unknown properties are allowed
 * (a newer API may add fields), but every field the app reads must have the contract's type.
 */

const technology = z.object({
  technology: z.string().min(1).max(100),
  name: z.string().max(200),
  versionRange: z.string().max(500),
  fixedIn: z.string().max(100).nullable(),
});

export const newsListItemSchema = z.object({
  id: z.number().int().nonnegative(),
  slug: z.string().min(1).max(200),
  url: z.string().max(2000),
  title: z.string().max(500),
  summary: z.string().max(5000),
  category: z.enum(NEWS_CATEGORIES),
  severity: z.enum(NEWS_SEVERITIES),
  technologies: z.array(technology).max(50),
  cveIds: z.array(z.string().max(50)).max(100),
  cvssScore: z.number().nullable(),
  tags: z.array(z.string().max(100)).max(100),
  publishedAt: z.string(),
  updatedAt: z.string(),
});

export const newsItemDetailSchema = newsListItemSchema.extend({
  bodyHtml: z.string().max(1_000_000),
  sourceLinks: z.array(z.object({ title: z.string().max(500), url: z.string().max(2000) })).max(50),
});

/** The page envelope. Items are checked one by one, so one odd item does not lose the rest. */
export const newsPageSchema = z.object({
  items: z.array(z.unknown()),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalItems: z.number().int(),
  totalPages: z.number().int(),
});
