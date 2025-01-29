import { Context } from 'hono/dist/types/context';
import { constructTwitterThread } from '../../../providers/twitter/conversation';
import { Constants } from '../../../constants';
import { userAPI } from '../../../providers/twitter/profile';
import { ContentfulStatusCode } from 'hono/utils/http-status';

export const statusAPIRequest = async (c: Context) => {
  const id = c.req.param('id') as string;

  const processedResponse = await constructTwitterThread(id, false, c, undefined);

  c.status(processedResponse.code as ContentfulStatusCode);
  // Add every header from Constants.API_RESPONSE_HEADERS
  for (const [header, value] of Object.entries(Constants.API_RESPONSE_HEADERS)) {
    c.header(header, value);
  }
  return c.json(processedResponse);
};

export const threadAPIRequest = async (c: Context) => {
  const id = c.req.param('id') as string;

  const processedResponse = await constructTwitterThread(id, true, c, undefined);

  c.status(processedResponse.code as ContentfulStatusCode);
  // Add every header from Constants.API_RESPONSE_HEADERS
  for (const [header, value] of Object.entries(Constants.API_RESPONSE_HEADERS)) {
    c.header(header, value);
  }
  return c.json(processedResponse);
};

export const profileAPIRequest = async (c: Context) => {
  const handle = c.req.param('handle') as string;

  const profileResponse = await userAPI(handle, c);

  c.status(profileResponse.code as ContentfulStatusCode);
  // Add every header from Constants.API_RESPONSE_HEADERS
  for (const [header, value] of Object.entries(Constants.API_RESPONSE_HEADERS)) {
    c.header(header, value);
  }
  return c.json(profileResponse);
};
