/**
 * Global test setup file.
 * Runs before all tests to configure the test environment.
 */

import dotenv from "dotenv";
import { beforeAll, afterAll, afterEach } from "vitest";

// Load test environment variables
dotenv.config({ path: ".env.test" });

// Set default test environment variables if not provided
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgresql://opensocial_api:test_password@localhost:5432/opensocial_test";
}

if (!process.env.ENCRYPTION_KEY) {
  // Test encryption key (32 bytes = 64 hex chars)
  process.env.ENCRYPTION_KEY = "a".repeat(64);
}

if (!process.env.COOKIE_SECRET) {
  process.env.COOKIE_SECRET = "test-cookie-secret-for-testing-purposes";
}

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

// config.serviceId is derived from OPENSOCIAL_SERVICE_DID at import time; set a
// default here (before any test module imports src/config) so tests that need
// it (e.g. serviceAuth) don't depend on import ordering within the test file.
process.env.OPENSOCIAL_SERVICE_DID ??= "did:web:localhost%3A3001";

// Setup global test hooks
beforeAll(async () => {
  // Global setup tasks
});

afterAll(async () => {
  // Global cleanup tasks
});

afterEach(() => {
  // Clear any mocks after each test
  vi.clearAllMocks();
});
