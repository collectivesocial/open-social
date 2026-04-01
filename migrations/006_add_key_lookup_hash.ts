import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Add a fast HMAC-SHA256 lookup column so the auth middleware can find the
  // correct app row by key without scanning every row with scrypt.
  await db.schema
    .alterTable('apps')
    .addColumn('key_lookup_hash', 'varchar(64)', (col) => col.unique())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('apps').dropColumn('key_lookup_hash').execute();
}
