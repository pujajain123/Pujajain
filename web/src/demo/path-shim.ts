const join = (...p: string[]) => p.filter(Boolean).join('/').replace(/\/+/g, '/');
const resolve = (...p: string[]) => '/' + join(...p).replace(/^\//, '');
const extname = (p: string) => (/\.[^./]*$/.exec(p)?.[0] ?? '');
export { join, resolve, extname };
export default { join, resolve, extname };
