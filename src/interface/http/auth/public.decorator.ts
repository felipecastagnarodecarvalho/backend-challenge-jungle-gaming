import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'wagering:isPublic';

/** Marks a route as open (health, metrics): the auth guard never runs for it. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
