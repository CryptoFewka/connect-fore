import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // android/ and ios/ hold generated native projects, and `cap sync` copies the
  // built bundle into android/app/src/main/assets/public. Flat config does not
  // read .gitignore, so without this `bun run lint` lints the build output.
  { ignores: ['dist/**', '.wrangler/**', 'node_modules/**', 'android/**', 'ios/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The simulation must stay deterministic and platform-free.
    files: ['src/game/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/game must run in the Durable Object too.' },
        { name: 'document', message: 'src/game must run in the Durable Object too.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded PRNG in src/game/rng.ts.' },
        { object: 'Date', property: 'now', message: 'The simulation must not read the clock.' },
      ],
    },
  },
);
