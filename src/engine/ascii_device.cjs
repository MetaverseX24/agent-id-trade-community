const os=require('node:os');
const {syncBuiltinESMExports}=require('node:module');
const original=os.hostname;
os.hostname=function(){const value=original();return /^[\x20-\x7e]+$/.test(value)?value:encodeURIComponent(value);};
syncBuiltinESMExports();
