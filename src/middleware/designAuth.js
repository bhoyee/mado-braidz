export function designAuth(catalog, realm = 'Mado owner design preview') {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.app.get('env') === 'production' && !req.secure)
      return res.status(403).send('HTTPS is required');
    try {
      const header = req.headers.authorization || '';
      if (header.startsWith('Basic ')) {
        const credentials = Buffer.from(header.slice(6), 'base64').toString(
          'utf8',
        );
        const colon = credentials.indexOf(':');
        if (colon > 0 && credentials.length < 1024) {
          const admin = await catalog.findAdmin(credentials.slice(0, colon));
          if (
            admin?.role === 'owner' &&
            (await (
              await import('argon2')
            ).default.verify(admin.passwordHash, credentials.slice(colon + 1)))
          ) {
            res.locals.admin = admin;
            return next();
          }
        }
      }
      res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
      return res.status(401).send('Owner sign-in required');
    } catch (error) {
      return next(error);
    }
  };
}
