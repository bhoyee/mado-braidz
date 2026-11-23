import { Router } from 'express';
import { designAuth } from '../../middleware/designAuth.js';
import { decorateCatalog } from '../public/index.js';
export function designRouter(catalog, limit) {
  const router = Router();
  router.get('/design', limit, designAuth(catalog), async (req, res, next) => {
    try {
      res.render('pages/design', {
        ...decorateCatalog(await catalog.load()),
        title: 'Design library | Mado African Braids',
        isDesign: true,
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
