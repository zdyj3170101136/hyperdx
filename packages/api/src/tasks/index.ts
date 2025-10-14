import { CronJob } from 'cron';
import http from 'http';
import minimist from 'minimist';
import { performance } from 'perf_hooks';
import { collectDefaultMetrics, register } from 'prom-client';
import { serializeError } from 'serialize-error';

import { RUN_SCHEDULED_TASKS_EXTERNALLY } from '@/config';
import { connectDB, mongooseConnection } from '@/models';
import logger from '@/utils/logger';

import checkAlerts from './checkAlerts';

const shutdown = async () => Promise.all([mongooseConnection.close()]);

// Start a lightweight metrics server for task processes
const startMetricsServer = (
  port = Number(process.env.METRICS_PORT) || 9091,
) => {
  collectDefaultMetrics();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(await register.metrics());
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  server.listen(port, () => {
    console.log(`Metrics server listening on :${port}/metrics`);
  });
  return server;
};

const main = async (taskName: string) => {
  // connect dbs
  await Promise.all([connectDB()]);

  const t0 = performance.now();
  logger.info(`Task [${taskName}] started at ${new Date()}`);
  switch (taskName) {
    case 'check-alerts':
      await checkAlerts();
      break;
    // only for testing
    case 'ping-pong':
      logger.info(`
                 O .
               _/|\\_-O
              ___|_______
             /     |     \
            /      |      \
           #################
          /   _ ( )|        \
         /    ( ) ||         \
        /  \\  |_/ |          \
       /____\\/|___|___________\
          |    |             |
          |   / \\           |
          |  /   \\          |
          |_/    /_
      `);
      break;
    default:
      throw new Error(`Unkown task name ${taskName}`);
  }
  logger.info(
    `Task [${taskName}] finished in ${(performance.now() - t0).toFixed(2)} ms`,
  );

  // await shutdown();
};

// 优雅停止标志
let isShuttingDown = false;
let currentJob: CronJob | null = null;

// Entry point
const argv = minimist(process.argv.slice(2));
const taskName = argv._[0];
// start metrics server regardless of cron mode
startMetricsServer();
// WARNING: the cron job will be enabled only in development mode
if (!RUN_SCHEDULED_TASKS_EXTERNALLY) {
  logger.info('In-app cron job is enabled');

  // 立即执行一次
  main(taskName).catch(err => {
    console.error('Initial execution failed:', err);
    logger.error(serializeError(err));
  });

  // run cron job every 1 minute
  currentJob = CronJob.from({
    cronTime: '0 * * * * *',
    waitForCompletion: true,
    onTick: async () => {
      if (isShuttingDown) {
        logger.info('Skipping task execution due to shutdown');
        return;
      }
      await main(taskName);
    },
    errorHandler: async err => {
      console.error(err);
      await shutdown();
    },
    start: true,
    timeZone: 'UTC',
  });
} else {
  logger.warn('In-app cron job is disabled');
  main(taskName)
    .then(() => {
      process.exit(0);
    })
    .catch(err => {
      console.log(err);
      logger.error(serializeError(err));
      process.exit(1);
    });
}

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) {
    logger.warn(`Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  try {
    const { default: DistributedLock } = await import(
      '@/models/distributedLock'
    );
    logger.info('Releasing distributed lock...');
    await DistributedLock.releaseLock();
    logger.info('Graceful shutdown completed');
  } catch (error) {
    logger.error('Error during graceful shutdown:', serializeError(error));
    throw error;
  }
};

// 处理停止信号
// 立即释放分布式锁以避免阻塞其他任务的启动。
// 不要立即退出，以等待当前正在运行的 check-alerts 全部运行结束。
// pod 的 terminationGracePeriodSeconds 应该设置为 >= 1minute。
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM').finally(() => {
    // 60 秒后自动退出
    setTimeout(() => {
      process.exit(0);
    }, 60000);
  });
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT').finally(() => {
    // 60 秒后自动退出
    setTimeout(() => {
      process.exit(0);
    }, 60000);
  });
});

process.on('uncaughtException', (err: Error) => {
  console.log(err);
  logger.error(serializeError(err));
  if (!isShuttingDown) {
    void gracefulShutdown('uncaughtException').finally(() => process.exit(1));
  }
});

process.on('unhandledRejection', (err: any) => {
  console.log(err);
  logger.error(serializeError(err));
  if (!isShuttingDown) {
    void gracefulShutdown('unhandledRejection').finally(() => process.exit(1));
  }
});
