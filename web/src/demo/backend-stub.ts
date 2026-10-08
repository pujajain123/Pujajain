// Stand-in for ./backend in the normal (server-backed) build, so the demo code is not bundled.
const unavailable = () => {
  throw new Error('Demo backend is only included in `npm run build:demo`');
};
export const startDemo = unavailable;
export const request = unavailable;
export const onChange = unavailable;
export const resetDemo = unavailable;
