import { EnvironmentService } from './environment.service';

// Direct instantiation with a stub ConfigService, mirroring the rest of these
// unit specs.
describe('EnvironmentService', () => {
  let service: EnvironmentService;

  beforeEach(() => {
    service = new EnvironmentService(
      {} as any, // configService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
