import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { TimelineRateLimitGuard } from './timeline-rate-limit.guard.js';
import { GetOrderTimeline } from '../../application/usecases/get-order-timeline.js';
import {
  type OrderTimelineResponse,
  toTimelineResponse,
} from './order-timeline.response.js';

@Controller('v1/assistant/orders')
export class OrderTimelineController {
  constructor(
    @Inject(GetOrderTimeline)
    private readonly getOrderTimeline: GetOrderTimeline,
  ) {}

  /** The order's history without the LLM, for the e2e tests and the frontend. */
  @Get(':orderId/timeline')
  @UseGuards(TimelineRateLimitGuard)
  async timeline(
    @Param('orderId') orderId: string,
  ): Promise<OrderTimelineResponse> {
    const timeline = await this.getOrderTimeline.execute(orderId);
    if (timeline === null) {
      // Same body as order-service's 404.
      throw new NotFoundException({ message: 'order not found' });
    }
    return toTimelineResponse(timeline);
  }
}
