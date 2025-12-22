import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { config } from './config';
import { createDb } from './db';
import { createOAuthClient } from './auth/client';
import { createAuthRouter } from './routes/auth';
import appRoutes from './routes/apps';
import communityRoutes from './routes/communities';
import memberRoutes from './routes/members';

dotenv.config();

const app = express();
const PORT = config.port;

// Middleware
app.use(cors({
  origin: config.nodeEnv === 'production' 
    ? [config.serviceUrl || ''] 
    : ['http://127.0.0.1:5174', 'http://localhost:5174'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Start server
async function start() {
  try {
    // Initialize database
    const db = createDb(config.databaseUrl);
    console.log('✅ Database connected');

    // Create OAuth tables if they don't exist
    await db.schema
      .createTable('auth_state')
      .ifNotExists()
      .addColumn('key', 'varchar(255)', (col) => col.primaryKey())
      .addColumn('state', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('auth_session')
      .ifNotExists()
      .addColumn('key', 'varchar(255)', (col) => col.primaryKey())
      .addColumn('session', 'text', (col) => col.notNull())
      .execute();

    console.log('✅ Auth tables ready');

    // Initialize OAuth client
    const oauthClient = await createOAuthClient(db);
    console.log('✅ OAuth client initialized');

    // Auth routes
    app.use(createAuthRouter(oauthClient, db));

    // API routes
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'opensocial-api'
      });
    });

    app.use('/api/v1/apps', appRoutes);
    app.use('/api/v1/communities', communityRoutes);
    app.use('/api/v1/communities', memberRoutes);

    // Error handling
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
    
    app.listen(PORT, () => {
      console.log(`✅ OpenSocial API running on port ${PORT}`);
      console.log(`   Health check: http://localhost:${PORT}/health`);
      console.log(`   Mode: ${config.nodeEnv}`);
      if (config.nodeEnv === 'development') {
        console.log(`   OAuth callback: http://127.0.0.1:${PORT}/oauth/callback`);
      }
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

start();
