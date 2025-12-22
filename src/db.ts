import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { AuthState, AuthSession } from './models/auth';

export interface Database {
  auth_state: AuthState;
  auth_session: AuthSession;
}

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
      }),
    }),
  });
}
