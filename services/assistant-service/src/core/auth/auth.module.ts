import { Module } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard.js';

/** The session guard, for the modules that own a protected route. */
@Module({
  providers: [SessionAuthGuard],
  exports: [SessionAuthGuard],
})
export class AuthModule {}
