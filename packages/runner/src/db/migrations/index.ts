/**
 * The ordered migration list.
 *
 * Order is the array order, and ids are prefixed so the two agree by eye.
 * Migrations are append-only: an applied migration is never edited, because a
 * scorecard is only reproducible if the schema that produced it is knowable.
 */

import type { Dialect } from '../dialect.js';
import * as init from './0000-init.js';

export interface Migration {
  readonly id: string;
  up(dialect: Dialect): string[];
}

export const MIGRATIONS: readonly Migration[] = [init];
