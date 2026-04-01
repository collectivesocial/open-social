import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Add a fast HMAC-SHA256 lookup column so the auth middleware can find the
  // correct app row by key without scanning every row with scrypt.
  //
  // The column is nullable so the migration is safe for existing rows —
  // PostgreSQL allows multiple NULLs in a UNIQUE column.  Apps registered
  // before this migration will have key_lookup_hash = NULL; the auth
  // middleware handles this via a lazy-migration fallback that backfills the
  // hash on first successful authentication.
  await db.schema
    .alterTable('apps')
    .addColumn('key_lookup_hash', 'varchar(64)', (col) => col.unique())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('apps').dropColumn('key_lookup_hash').execute();
}
