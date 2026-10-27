import test from 'node:test';import assert from 'node:assert/strict';
import {networkEnvironment} from '../src/engine/network_env.mjs';
test('uses the user existing proxy only in this process and excludes local wallet traffic',()=>{
 const original={HOME:'unchanged'},options={platform:'win32',readSystem:()=> 'http://127.0.0.1:12345',supportsProxy:true};
 const env=networkEnvironment(original,options);assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:12345');assert.match(env.NODE_OPTIONS,/--use-env-proxy/);
 assert.equal(env.HOME,original.HOME);assert.equal(original.HTTPS_PROXY,undefined);assert.match(env.NO_PROXY,/127\.0\.0\.1/);
 const explicit=networkEnvironment({HTTPS_PROXY:'http://example.test:12345',NODE_OPTIONS:'--trace-warnings'},options);
 assert.equal(explicit.HTTPS_PROXY,'http://example.test:12345');assert.match(explicit.NODE_OPTIONS,/--trace-warnings/);
 assert.equal(networkEnvironment({}, {platform:'linux',supportsProxy:true}).HTTPS_PROXY,undefined);
 assert.throws(()=>networkEnvironment({}, {...options,supportsProxy:false}),/Node.js/);
});
