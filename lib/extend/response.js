const { STATUS_CODES } = require('http');
const fs = require('fs');

const Cache = require('../cache');
const { getMimeType } = require('../mime');
const { defineProperty } = require('../utils');

const TYPE = 'Content-Type';

const CONTENT_LENGTH = 'Content-Length';

const X_CONTENT_TYPE_OPTIONS = 'X-Content-Type-Options';

const OCTET_STREAM = 'application/octet-stream';

const APPLICATION_JSON = 'application/json;charset=utf-8';

const TEXT_PLAIN = 'text/plain;charset=utf-8';

const TEXT_JAVASCRIPT = 'text/javascript;charset=utf-8';

const TEXT_HTML = 'text/html;charset=utf-8';

const NOSNIFF = 'nosniff';

const SET_COOKIE = 'Set-Cookie';

function handleSendArguments() {
  let cached = false;

  let statusCode = this.statusCode || 200;

  const headers = {};

  for (let i = 1; i < arguments.length; i += 1) {
    const arg = arguments[i];

    const type = typeof arg;

    if (type === 'number') {
      statusCode = arg;
    } else if (type === 'object') {
      for (const key in arg) {
        if (Object.hasOwnProperty.call(arg, key)) {
          const value = arg[key];

          headers[key] = value;
        }
      }
    } else if (type === 'boolean') {
      cached = arg;
    }
  }

  return { statusCode, headers, cached };
}

function cookieSerialize(name, value, options) {
  const opt = options || {};

  const enc = opt.encode || encodeURIComponent;

  const pairs = [`${name}=${enc(value)}`];

  if (opt.maxAge != null) {
    const maxAge = opt.maxAge - 0;

    if (Number.isNaN(maxAge)) throw new Error('maxAge should be a Number');

    pairs.push(`Max-Age=${maxAge}`);
  }

  if (opt.domain) pairs.push(`Domain=${opt.domain}`);

  if (opt.path) pairs.push(`Path=${opt.path}`);

  if (opt.expires) pairs.push(`Expires=${opt.expires.toUTCString()}`);

  if (opt.httpOnly) pairs.push('HttpOnly');

  if (opt.secure) pairs.push('Secure');

  if (opt.sameSite) {
    const sameSite =
      typeof opt.sameSite === 'string'
        ? opt.sameSite.toLowerCase()
        : opt.sameSite;

    switch (sameSite) {
      case true:
        pairs.push('SameSite=Strict');
        break;
      case 'lax':
        pairs.push('SameSite=Lax');
        break;
      case 'strict':
        pairs.push('SameSite=Strict');
        break;
      case 'none':
        pairs.push('SameSite=None');
        break;
      default:
        throw new TypeError('option sameSite is invalid');
    }
  }

  return pairs.join('; ');
}

function stringify(value, replacer, spaces, escape) {
  let json =
    replacer || spaces
      ? JSON.stringify(value, replacer, spaces)
      : JSON.stringify(value);

  if (escape) {
    json = json.replace(/[<>&]/g, (c) => {
      switch (c.charCodeAt(0)) {
        case 0x3c:
          return '\\u003c';
        case 0x3e:
          return '\\u003e';
        case 0x26:
          return '\\u0026';
        default:
          return c;
      }
    });
  }

  return json;
}

module.exports.writeHead = function (originalWriteHead) {
  const args = Array.from(arguments);

  args.shift();

  if (Array.isArray(this.$cookies)) {
    this.setHeader(SET_COOKIE, this.$cookies.filter(Boolean));
  }

  this.$cookies = undefined;

  return originalWriteHead.apply(this, args);
};

module.exports.status = function (code) {
  this.statusCode = code;

  return this;
};

module.exports.header = function (name, value) {
  this.setHeader(name, value);

  return this;
};

module.exports.cookie = function (name, value, options) {
  if (!Array.isArray(this.$cookies)) {
    defineProperty(this, '$cookies', [], true);
  }

  this.$cookies.push(cookieSerialize(name, value, options));

  return this;
};

module.exports.clearCookie = function (name, options) {
  const opts = options || {};

  Object.assign(opts, { expires: new Date(1), path: '/' });

  return this.cookie(name, '', opts);
};

module.exports.redirect = function (url) {
  let address = url;

  let statusCode = 302;

  if (arguments.length === 2) {
    if (typeof arguments[0] === 'number') {
      statusCode = arguments[0];
      address = arguments[1];
    } else {
      statusCode = arguments[1];
    }
  }

  this.statusCode = statusCode;

  this.writeHead(statusCode, { Location: address });

  this.end();
};

module.exports.send = function (data) {
  const cache = this.cache;

  let body = data;

  const { statusCode, headers, cached } = handleSendArguments.apply(
    this,
    arguments,
  );

  let contentType = headers[TYPE] || this.getHeader(TYPE);

  // Cast body type.
  if (body && typeof body.pipe === 'function') {
    headers[TYPE] = contentType || OCTET_STREAM;

    this.writeHead(statusCode, headers);

    return body.pipe(this);
  }

  if (body instanceof Buffer) {
    contentType = contentType || OCTET_STREAM;
  } else if (typeof body === 'object') {
    body = JSON.stringify(body);

    contentType = contentType || APPLICATION_JSON;
  } else {
    body = body || STATUS_CODES[statusCode];
  }

  headers[TYPE] = contentType || TEXT_PLAIN;

  headers[CONTENT_LENGTH] = Buffer.byteLength(body);

  this.statusCode = statusCode;

  if (cached && cache instanceof Cache) {
    const bodyAsString = JSON.stringify(body);

    const key = this.request.originalUrl;

    const cachedData = cache.get(key);

    if (cachedData === bodyAsString) {
      this.statusCode = statusCode;

      this.writeHead(statusCode, headers);

      return this.end(body);
    }

    cache.set(key, bodyAsString);
  }

  this.writeHead(statusCode, headers);

  return this.end(body);
};

module.exports.json = function (data) {
  const body = JSON.parse(JSON.stringify(data));

  const { cached, statusCode, headers } = handleSendArguments.apply(
    this,
    arguments,
  );

  return this.send(body, cached, statusCode, headers);
};

module.exports.jsonp = function (data) {
  const val = data;

  let cached = true;

  let opts = {};

  if (arguments.length > 1) {
    if (typeof arguments[1] === 'boolean') {
      cached = arguments[1];

      opts = arguments[2] || {};
    } else {
      cached = arguments[2];

      opts = arguments[1] || {};
    }
  }

  const { escape, replacer, spaces, callbackName = 'callback' } = opts;

  let body = stringify(val, replacer, spaces, escape);

  let callback = this.request.query[callbackName];

  if (!this.getHeader(TYPE)) {
    this.setHeader(X_CONTENT_TYPE_OPTIONS, NOSNIFF);
    this.setHeader(TYPE, APPLICATION_JSON);
  }

  if (typeof callback === 'string' && callback.length !== 0) {
    this.setHeader(X_CONTENT_TYPE_OPTIONS, NOSNIFF);
    this.setHeader(TYPE, TEXT_JAVASCRIPT);

    callback = callback.replace(/[^[\]\w$.]/g, '');

    body = body.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

    body = `/**/ typeof ${callback} === 'function' && ${callback}(${body});`;
  }

  return this.send(body, cached);
};

module.exports.sendFile = function (filePath, options) {
  const { headers } = options || {};

  const readStream = fs.createReadStream(filePath);

  const mimeType = getMimeType(filePath);
  this.setHeader(TYPE, `${mimeType.type};charset=utf-8`);

  const stat = fs.statSync(filePath);
  this.setHeader(CONTENT_LENGTH, stat.size);

  if (typeof headers === 'object') {
    for (const key in headers) {
      if (Object.hasOwnProperty.call(headers, key)) {
        const value = headers[key];

        this.setHeader(key, value);
      }
    }
  }

  return readStream.pipe(this);
};

module.exports.render = function (filename, options, callback) {
  const self = this;

  const { dir, ext, engine } = self.views || {};

  if (typeof dir !== 'string') throw new Error('dir must be a string.');

  if (typeof ext !== 'string') throw new Error('ext must be a string.');

  if (typeof engine !== 'function')
    throw new Error('engine must be a function.');

  let done = callback;

  let opts = options || {};

  if (typeof options === 'function') {
    done = options;

    opts = {};
  }

  const pathView = `${dir}/${filename}.${ext.replace(/\./g, '')}`;

  done =
    done ||
    function defaultDone(error, out) {
      if (error) throw error;

      return self.send(out, { [TYPE]: TEXT_HTML });
    };

  return engine(pathView, opts, done);
};