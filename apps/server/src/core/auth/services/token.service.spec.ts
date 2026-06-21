import { TokenService } from './token.service';

// Direct instantiation with stub deps, mirroring the rest of these unit specs.
describe('TokenService', () => {
  let service: TokenService;

  beforeEach(() => {
    service = new TokenService(
      {} as any, // jwtService
      {} as any, // environmentService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
