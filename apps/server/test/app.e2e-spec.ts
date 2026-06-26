import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // Docmost runs on Fastify (see src/main.ts). The default
    // createNestApplication() would load @nestjs/platform-express, which is not
    // a dependency of this project, so an explicit FastifyAdapter is required.
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    // Fastify must finish booting before its HTTP server can serve requests.
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    // Guard with optional chaining: if beforeEach throws before `app` is
    // assigned, closing undefined would mask the original failure.
    await app?.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});
