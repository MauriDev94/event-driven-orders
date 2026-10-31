import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ENV, type Env } from './core/config/env.js';
import { CoreModule } from './core/core.module.js';
import { loggerParams } from './core/observability/logging.js';
import { OrderHistoryModule } from './features/order-history/order-history.module.js';

@Module({
  imports: [
    CoreModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => loggerParams(env),
    }),
    OrderHistoryModule,
  ],
})
export class AppModule {}
