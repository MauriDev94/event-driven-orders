import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import amqplib, {
  type Channel,
  type ChannelModel,
  type RecoveringChannelModel,
} from 'amqplib';
import { ENV, type Env } from '../config/env.js';

/** Work that runs on a fresh channel after every (re)connection. */
export type ChannelSetup = (channel: Channel) => Promise<void>;

/**
 * The broker connection of the process, with amqplib's built-in recovery:
 * after each (re)connection it opens a channel and runs every registered
 * setup (declare the topology, start consuming), like aio-pika's
 * RobustConnection in the Python services (ADR-0013).
 *
 * Connecting never blocks startup nor throws: with the broker down the
 * service runs, /health reports `broker: unhealthy` (ADR-0014) and amqplib
 * keeps retrying with backoff.
 */
@Injectable()
export class RabbitMQConnection
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RabbitMQConnection.name);
  private readonly setups: ChannelSetup[] = [];
  private connection: RecoveringChannelModel | null = null;
  private ready = false;

  constructor(@Inject(ENV) private readonly env: Pick<Env, 'RABBITMQ_URL'>) {}

  /** Register before the application bootstraps (from an onModuleInit hook). */
  addSetup(setup: ChannelSetup): void {
    this.setups.push(setup);
  }

  /** Connected, and every setup ran on the current connection. */
  isConnected(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    if (this.connection !== null) return;
    const connection = await amqplib.connect(this.env.RABBITMQ_URL, {
      recovery: {
        waitForConnect: false,
        initialDelay: 1_000,
        maxDelay: 30_000,
        setup: async (model: ChannelModel) => {
          const channel = await model.createChannel();
          channel.on('error', (error: Error) =>
            this.logger.error(`channel error: ${error.message}`),
          );
          for (const setup of this.setups) {
            await setup(channel);
          }
          this.ready = true;
          this.logger.log('connected to RabbitMQ and consuming');
        },
      },
    });
    connection.on('disconnect', (error: Error) => {
      this.ready = false;
      this.logger.warn(`disconnected from RabbitMQ: ${error.message}`);
    });
    connection.on('connect-failed', (error: Error) => {
      this.logger.warn(`could not connect to RabbitMQ: ${error.message}`);
    });
    connection.on('error', (error: Error) => {
      this.logger.warn(`RabbitMQ connection error: ${error.message}`);
    });
    this.connection = connection;
  }

  async close(): Promise<void> {
    this.ready = false;
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
  }

  onApplicationBootstrap(): Promise<void> {
    return this.start();
  }

  onModuleDestroy(): Promise<void> {
    return this.close();
  }
}
