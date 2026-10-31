import type { ChannelSetup } from '../../src/core/messaging/rabbitmq.connection.js';

/**
 * Stands in for RabbitMQConnection in HTTP tests, so they never open a
 * socket to a broker (the Python suites do the same with a broker-down double).
 */
export class FakeBroker {
  readonly setups: ChannelSetup[] = [];

  constructor(private readonly connected = false) {}

  addSetup(setup: ChannelSetup): void {
    this.setups.push(setup);
  }

  async start(): Promise<void> {}

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {}
}
