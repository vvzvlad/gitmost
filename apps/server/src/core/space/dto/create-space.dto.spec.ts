import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSpaceDto } from './create-space.dto';
import { UpdateSpaceDto } from './update-space.dto';

describe('space appearance input', () => {
  it('accepts a bounded icon and a six-digit HEX color at creation', async () => {
    expect(
      await validate(
        plainToInstance(CreateSpaceDto, {
          name: 'Design',
          slug: 'design',
          icon: 'rocket',
          iconColor: '#7c3aed',
        }),
      ),
    ).toHaveLength(0);
  });

  it.each([
    { iconColor: 'red' },
    { iconColor: '#123' },
    { iconColor: 'url(https://example.org)' },
    { icon: '<svg>' },
    { icon: 'a'.repeat(41) },
    { icon: {} },
  ])('rejects invalid appearance %j', async (appearance) => {
    expect(
      (
        await validate(
          plainToInstance(CreateSpaceDto, {
            name: 'Design',
            slug: 'design',
            ...appearance,
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('allows explicit reset and a partial update', async () => {
    for (const appearance of [
      { icon: null, iconColor: null },
      { iconColor: '#166c9d' },
    ]) {
      expect(
        await validate(
          plainToInstance(UpdateSpaceDto, {
            spaceId: '5efbe15c-336e-4a40-8080-7764a5f83581',
            ...appearance,
          }),
        ),
      ).toHaveLength(0);
    }
  });
});
