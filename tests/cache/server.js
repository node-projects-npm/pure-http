const timeout = require('connect-timeout');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const pureHttp = require('../..');

const app = pureHttp({
  cache: pureHttp.Cache({ maxAge: 60000, max: 2 }),
});

const sleep = (fn, wait) =>
  new Promise((resolve) => setTimeout(() => resolve(fn()), wait));

app.use([
  bodyParser.json(),
  bodyParser.urlencoded({ extended: true }),
  cookieParser(),
  timeout('30s'),
  (req, res, next) => {
    res.cache.has({});
    res.cache.get({});

    res.cache.set('/get-cache', {
      raw: JSON.stringify('data'),
      method: 'GET',
      headers: {},
    });

    return next();
  },
]);

app.get('/get-cache', (req, res) => res.send('data', true));

app.post('/set-cache', (req, res) => res.send('data', true));

app.delete('/delete-cache', (req, res) => {
  const cache = pureHttp.Cache({ maxAge: 5 });

  cache.set('1', req.originalUrl);
  cache.set('2', req.originalUrl);
  cache.delete('1');
  cache.delete({});

  sleep(() => {
    cache.get('2');
    cache.delete('2');

    res.send('Ok');
  }, 3000);
});

app.get('/jsonp-with-escape', (req, res) => {
  res.jsonp({ '&': '\u2028<script>\u2029' }, true, { escape: true });
});

app.all('/error', (req, res) => {
  res.cache.set({}, 'error');
});

module.exports = app;
