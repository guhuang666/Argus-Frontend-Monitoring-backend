import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ErrorEventsModule } from './error-events/error-events.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        // 连接池按需，默认 100 够用
        maxPoolSize: 10,
      }),
    }),
    ErrorEventsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
