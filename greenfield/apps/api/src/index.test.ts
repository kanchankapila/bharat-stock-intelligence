import { expect, test } from 'vitest';
import { PACKAGE_NAME } from './index.js';

test('package resolves', () => {
  expect(PACKAGE_NAME).toBe('@greenfield/api');
});
