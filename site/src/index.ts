import installScript from '../../scripts/install.sh';
import { handleSiteRequest, type SiteEnv } from './worker';

export default {
  fetch(request: Request, env: SiteEnv): Promise<Response> {
    return handleSiteRequest(request, env, installScript);
  },
};
