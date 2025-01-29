import { Context } from 'hono';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import i18next from 'i18next';
import icu from 'i18next-icu';
import { Constants } from '../constants';
import { handleQuote } from '../helpers/quote';
import { formatNumber, sanitizeText, truncateWithEllipsis } from '../helpers/utils';
import { Strings } from '../strings';
import { getSocialProof } from '../helpers/socialproof';
import { renderPhoto } from '../render/photo';
import { renderVideo } from '../render/video';
import { renderInstantView } from '../render/instantview';
import { constructTwitterThread } from '../providers/twitter/conversation';
import { Experiment, experimentCheck } from '../experiments';
import translationResources from '../../i18n/resources';
import { constructBlueskyThread } from '../providers/bsky/conversation';
import { DataProvider } from '../enum';

export const returnError = (c: Context, error: string): Response => {
  let branding = Constants.BRANDING_NAME;
  if (c.req.url.includes('bsky')) {
    branding = Constants.BRANDING_NAME_BSKY;
  }
  return c.html(
    Strings.BASE_HTML.format({
      brandingName: branding,
      lang: '',
      headers: [
        `<meta property="og:title" content="${branding}"/>`,
        `<meta property="og:description" content="${error}"/>`
      ].join('')
    })
  ) as Response;
};
/* Handler for Twitter statuses (Tweets).
   Like Twitter, we use the terminologies interchangably. */
export const handleStatus = async (
  c: Context,
  statusId: string,
  authorHandle: string | null,
  mediaNumber: number | undefined,
  userAgent: string,
  flags: InputFlags,
  language: string | undefined,
  provider: DataProvider
  // eslint-disable-next-line sonarjs/cognitive-complexity
): Promise<Response> => {
  console.log('Direct?', flags?.direct);

  let fetchWithThreads = false;

  if (
    c.req.header('user-agent')?.includes('Telegram') &&
    !flags?.direct &&
    flags.instantViewUnrollThreads
  ) {
    fetchWithThreads = true;
  }

  let thread: SocialThread;
  if (provider === DataProvider.Twitter) {
    thread = await constructTwitterThread(
      statusId,
      fetchWithThreads,
      c,
      language,
      flags?.api ?? false
    );
  } else if (provider === DataProvider.Bsky) {
    thread = await constructBlueskyThread(
      statusId,
      authorHandle ?? '',
      fetchWithThreads,
      c,
      language
    );
  } else {
    return returnError(c, Strings.ERROR_API_FAIL);
  }

  const status = thread?.status as APIStatus;

  const api = {
    code: thread.code,
    message: '',
    tweet: status
  };

  switch (api.code) {
    case 200:
      api.message = 'OK';
      break;
    case 401:
      api.message = 'PRIVATE_TWEET';
      break;
    case 404:
      api.message = 'NOT_FOUND';
      break;
    case 500:
      console.log(api);
      api.message = 'API_FAIL';
      break;
  }

  /* Catch this request if it's an API response */
  if (flags?.api) {
    c.status(api.code as ContentfulStatusCode);
    // Add every header from Constants.API_RESPONSE_HEADERS
    for (const [header, value] of Object.entries(Constants.API_RESPONSE_HEADERS)) {
      c.header(header, value);
    }
    return c.json(api);
  }

  if (status === null) {
    if (provider === DataProvider.Bsky) {
      return returnError(c, Strings.ERROR_BLUESKY_POST_NOT_FOUND);
    } else {
      return returnError(c, Strings.ERROR_TWEET_NOT_FOUND);
    }
  }

  /* If there was any errors fetching the Tweet, we'll return it */
  switch (api.code) {
    case 401:
      return returnError(c, Strings.ERROR_PRIVATE);
    case 404:
      if (provider === DataProvider.Bsky) {
        return returnError(c, Strings.ERROR_BLUESKY_POST_NOT_FOUND);
      } else {
        return returnError(c, Strings.ERROR_TWEET_NOT_FOUND);
      }
    case 500:
      console.log(api);
      return returnError(c, Strings.ERROR_API_FAIL);
  }

  const isTelegram = (userAgent || '').indexOf('Telegram') > -1;
  const isDiscord = (userAgent || '').indexOf('Discord') > -1;
  /* Should sensitive statuses be allowed Instant View? */
  let useIV = false;

  if (isTelegram && !flags?.direct && !flags?.gallery && !flags?.api) {
    if (status.provider === 'twitter') {
      const twitterStatus = status as APITwitterStatus;
      useIV =
        useIV ||
        !!(
          twitterStatus.is_note_tweet ||
          twitterStatus.translation ||
          twitterStatus.community_note
        );
    }
    useIV =
      useIV ||
      !!(
        status.media?.photos?.[0] || // Force instant view for photos for now https://bugs.telegram.org/c/33679
        status.media?.mosaic ||
        status.quote ||
        flags?.forceInstantView ||
        (thread?.thread?.length ?? 0) > 1
      );
  }

  /* Force enable IV for archivers */
  if (flags?.archive) {
    useIV = true;
  }

  let ivbody = '';

  let overrideMedia: APIMedia | undefined;

  await i18next.use(icu).init({
    lng: language ?? status.lang ?? 'en',
    resources: translationResources,
    fallbackLng: 'en'
  });

  // Check if mediaNumber exists, and if that media exists in status.media.all. If it does, we'll store overrideMedia variable
  if (mediaNumber && status.media && status.media.all && status.media.all[mediaNumber - 1]) {
    overrideMedia = status.media.all[mediaNumber - 1];
  }

  /* Catch direct media request (d.fxtwitter.com, or .mp4 / .jpg) */
  if (flags?.direct && !flags?.textOnly && status.media) {
    let redirectUrl: string | null = null;
    const all = status.media.all || [];
    // if (status.media.videos) {
    //   const { videos } = status.media;
    //   redirectUrl = (videos[(mediaNumber || 1) - 1] || videos[0]).url;
    // } else if (status.media.photos) {
    //   const { photos } = status.media;
    //   redirectUrl = (photos[(mediaNumber || 1) - 1] || photos[0]).url;
    // }

    const selectedMedia = all[(mediaNumber || 1) - 1];
    if (selectedMedia) {
      redirectUrl = selectedMedia.url;
    } else if (all.length > 0) {
      redirectUrl = all[0].url;
    }

    if (redirectUrl) {
      // Only append name if it's an image
      if (/\.(png|jpe?g|gif)(\?|$)/.test(redirectUrl) && flags.name) {
        redirectUrl = `${redirectUrl}:${flags.name}`;
      }
      return c.redirect(redirectUrl, 302);
    }
  }

  /* User requested gallery view, but this isn't a status with media */
  if (flags.gallery && (status.media?.all?.length ?? 0) < 1) {
    flags.gallery = false;
  }

  /* At this point, we know we're going to have to create a
     regular embed because it's not an API or direct media request */

  let authorText = getSocialProof(status) || Strings.DEFAULT_AUTHOR_TEXT;
  const engagementText = authorText.replace(/ {4}/g, ' ');
  let siteName =
    status.provider === DataProvider.Twitter
      ? Constants.BRANDING_NAME
      : Constants.BRANDING_NAME_BSKY;

  if (thread.thread && thread.thread.length > 1 && isTelegram && useIV) {
    siteName = i18next.t('threadIndicator', { brandingName: siteName });
  }

  let newText = status.text;

  /* Base headers included in all responses */
  const headers = [];

  if (status.provider === DataProvider.Twitter) {
    headers.push(
      `<link rel="canonical" href="${Constants.TWITTER_ROOT}/${status.author.screen_name}/status/${status.id}"/>`,
      `<meta property="og:url" content="${Constants.TWITTER_ROOT}/${status.author.screen_name}/status/${status.id}"/>`,
      `<meta property="twitter:site" content="@${status.author.screen_name}"/>`,
      `<meta property="twitter:creator" content="@${status.author.screen_name}"/>`
    );
  } else if (status.provider === DataProvider.Bsky) {
    headers.push(
      `<link rel="canonical" href="${Constants.BSKY_ROOT}/profile/${status.author.screen_name}/post/${status.id}"/>`,
      `<meta property="og:url" content="${Constants.BSKY_ROOT}/profile/${status.author.screen_name}/post/${status.id}"/>`
    );
  }

  if (!flags.gallery) {
    if (status.provider === DataProvider.Twitter) {
      headers.push(`<meta property="theme-color" content="#00a8fc"/>`);
    } else if (status.provider === DataProvider.Bsky) {
      headers.push(`<meta property="theme-color" content="#0085ff"/>`);
    }
    headers.push(
      `<meta property="twitter:title" content="${status.author.name} (@${status.author.screen_name})"/>`
    );
  }

  /* This little thing ensures if by some miracle a FixTweet embed is loaded in a browser,
     it will gracefully redirect to the destination instead of just seeing a blank screen.

     Telegram is dumb and it just gets stuck if this is included, so we never include it for Telegram UAs. */
  if (!isTelegram && provider === DataProvider.Twitter) {
    headers.push(
      `<meta http-equiv="refresh" content="0;url=${Constants.TWITTER_ROOT}/${status.author.screen_name}/status/${status.id}"/>`
    );
  }

  if (useIV) {
    try {
      const instructions = renderInstantView({
        status: status,
        thread: thread,
        text: newText,
        flags: flags,
        targetLanguage: language ?? status.lang ?? 'en'
      });
      headers.push(...instructions.addHeaders);
      if (instructions.authorText) {
        authorText = instructions.authorText;
      }
      ivbody = instructions.text || '';
    } catch (e) {
      console.log('Error rendering Instant View', e, (e as Error)?.stack);
      useIV = false;
    }
  }

  /* This status has a translation attached to it, so we'll render it. */
  if ((status as APITwitterStatus).translation) {
    const { translation } = status as APITwitterStatus;

    const formatText = `📑 {translation}`.format({
      translation: i18next.t('translatedFrom').format({
        language: i18next.t(`language_${translation?.source_lang}`)
      })
    });

    newText = `${formatText}\n\n` + `${translation?.text}\n\n`;
  }

  console.log('overrideMedia', JSON.stringify(overrideMedia));
  console.log('media', JSON.stringify(status.media));

  if (!flags?.textOnly) {
    const media =
      status.media?.all && status.media?.all.length > 0 ? status.media : status.quote?.media || {};
    if (overrideMedia) {
      let instructions: ResponseInstructions;

      switch (overrideMedia.type) {
        case 'photo':
          /* This status has a photo to render. */
          instructions = renderPhoto(
            {
              status: status,
              authorText: authorText,
              engagementText: engagementText,
              userAgent: userAgent,
              isOverrideMedia: true
            },
            overrideMedia as APIPhoto
          );
          headers.push(...instructions.addHeaders);
          if (instructions.authorText) {
            authorText = instructions.authorText;
          }
          if (instructions.siteName) {
            siteName = instructions.siteName;
          }
          /* Overwrite our Twitter Card if overriding media, so it displays correctly in Discord */
          if (status.embed_card === 'player') {
            status.embed_card = 'summary_large_image';
          }
          break;
        case 'video':
          instructions = renderVideo(
            { status: status, userAgent: userAgent, text: newText, isOverrideMedia: true },
            overrideMedia as APIVideo
          );
          headers.push(...instructions.addHeaders);
          if (instructions.authorText) {
            authorText = instructions.authorText;
          }
          if (instructions.siteName) {
            siteName = instructions.siteName;
          }
          /* Overwrite our Twitter Card if overriding media, so it displays correctly in Discord */
          if (status.embed_card !== 'player') {
            status.embed_card = 'player';
          }
          /* This status has a video to render. */
          break;
      }
    } else if (media?.videos && !flags.nativeMultiImage) {
      const instructions = renderVideo(
        { status: status, userAgent: userAgent, text: newText },
        media.videos[0]
      );
      headers.push(...instructions.addHeaders);
      if (instructions.authorText) {
        authorText = instructions.authorText;
      }
      if (instructions.siteName) {
        siteName = instructions.siteName;
      }
    } else if (media?.mosaic) {
      if (
        experimentCheck(Experiment.DISCORD_NATIVE_MULTI_IMAGE, isDiscord) &&
        flags.nativeMultiImage
      ) {
        const photos = status.media?.photos || [];

        photos.forEach(photo => {
          /* Override the card type */
          status.embed_card = 'summary_large_image';
          console.log('set embed_card to summary_large_image');

          const instructions = renderPhoto(
            {
              status: status,
              authorText: authorText,
              engagementText: engagementText,
              userAgent: userAgent
            },
            photo
          );
          headers.push(...instructions.addHeaders);
        });
      } else {
        const instructions = renderPhoto(
          {
            status: status,
            authorText: authorText,
            engagementText: engagementText,
            userAgent: userAgent
          },
          media.mosaic
        );
        headers.push(...instructions.addHeaders);
      }
    } else if (media?.photos) {
      console.log('photos', media?.photos);
      const instructions = renderPhoto(
        {
          status: status,
          authorText: authorText,
          engagementText: engagementText,
          userAgent: userAgent
        },
        media.photos[0]
      );
      headers.push(...instructions.addHeaders);
    }
    if (status.media?.external && !status.media.videos?.length && !flags.nativeMultiImage) {
      const { external } = status.media;
      authorText = newText || '';
      headers.push(
        `<meta property="twitter:player" content="${external.url}">`,
        `<meta property="twitter:player:width" content="${external.width}">`,
        `<meta property="twitter:player:height" content="${external.height}">`,
        `<meta property="og:type" content="video.other">`,
        `<meta property="og:video:url" content="${external.url}">`,
        `<meta property="og:video:secure_url" content="${external.url}">`,
        `<meta property="og:video:width" content="${external.width}">`,
        `<meta property="og:video:height" content="${external.height}">`
      );
      if (external.thumbnail_url && !status.media.photos?.length) {
        headers.push(`<meta property="og:image" content="${external.thumbnail_url}">`);
      }
    }
  }

  /* This status contains a poll, so we'll render it */
  if (status.poll) {
    const { poll } = status;
    let barLength = 32;
    let str = '';

    /* Telegram Embeds are smaller, so we use a smaller bar to compensate */
    if (isTelegram) {
      barLength = 24;
    }

    /* Render each poll choice */
    status.poll.choices.forEach(choice => {
      const bar = '█'.repeat((choice.percentage / 100) * barLength);
      // eslint-disable-next-line no-irregular-whitespace
      str += `${bar}\n${choice.label}  (${choice.percentage}%)\n`;
    });

    /* Finally, add the footer of the poll with # of votes and time left */
    str += '\n'; /* TODO: Localize time left */
    str += i18next.t('pollVotes', {
      voteCount: formatNumber(poll.total_votes),
      timeLeft: poll.time_left_en
    });

    /* Check if the poll is ongoing and apply low TTL cache control.
       Yes, checking if this is a string is a hacky way to do this, but
       it can do it in way less code than actually comparing dates */
    if (poll.time_left_en !== 'Final results') {
      c.header('cache-control', Constants.POLL_TWEET_CACHE);
    }

    /* And now we'll put the poll right after the Tweet text! */
    newText += `\n\n${str}`;
  }

  /* This Tweet quotes another Tweet, so we'll render the other Tweet where possible */
  if (api.tweet?.quote) {
    const quoteText = handleQuote(api.tweet.quote);
    newText += `\n${quoteText}`;
  }

  /* If we have no media to display, instead we'll display the user profile picture in the embed */
  if (
    !status.media?.videos &&
    !status.media?.photos &&
    !status.quote?.media?.photos &&
    !status.quote?.media?.videos &&
    !flags?.textOnly
  ) {
    /* Use a slightly higher resolution image for profile pics */
    const avatar = status.author.avatar_url;
    if (!useIV) {
      headers.push(
        `<meta property="og:image" content="${avatar}"/>`,
        `<meta property="twitter:image" content="0"/>`
      );
    } else {
      headers.push(`<meta property="twitter:image" content="${avatar}"/>`);
    }
  }

  /* For supporting Telegram IV, we have to replace newlines with <br> within the og:description <meta> tag because of its weird (undocumented?) behavior.
     If you don't use IV, it uses newlines just fine. Just like Discord and others. But with IV, suddenly newlines don't actually break the line anymore.

     This is incredibly stupid, and you'd think this weird behavior would not be the case. You'd also think embedding a <br> inside the quotes inside
     a meta tag shouldn't work, because that's stupid, but alas it does.
     
     A possible explanation for this weird behavior is due to the Medium template we are forced to use because Telegram IV is not an open platform
     and we have to pretend to be Medium in order to get working IV, but haven't figured if the template is causing issues.  */
  const text = useIV ? sanitizeText(newText).replace(/\n/g, '<br>') : sanitizeText(newText);

  const useCard = status.embed_card === 'tweet' ? status.quote?.embed_card : status.embed_card;

  /* Push basic headers relating to author, Tweet text, and site name */
  headers.push(`<meta property="twitter:card" content="${useCard}"/>`);

  if (!flags.gallery) {
    headers.push(
      `<meta property="og:title" content="${status.author.name} (@${status.author.screen_name})"/>`,
      `<meta property="og:description" content="${text}"/>`,
      `<meta property="og:site_name" content="${siteName}"/>`
    );
  } else {
    if (isTelegram) {
      headers.push(
        `<meta property="og:site_name" content="${status.author.name} (@${status.author.screen_name})"/>`
      );
    } else {
      headers.push(
        `<meta property="og:title" content="${status.author.name} (@${status.author.screen_name})"/>`
      );
    }
  }

  /* Special reply handling if authorText is not overriden */
  if (status.replying_to && authorText === Strings.DEFAULT_AUTHOR_TEXT) {
    authorText = `↪ ${i18next.t('replyingTo').format({ screen_name: status.replying_to.screen_name })}`;
    /* We'll assume it's a thread if it's a reply to themselves */
  } else if (
    status.replying_to?.screen_name === status.author.screen_name &&
    authorText === Strings.DEFAULT_AUTHOR_TEXT
  ) {
    authorText = `↪ ${i18next.t('threadPartHeader').format({ screen_name: status.author.screen_name })}`;
  }

  if (!flags.gallery) {
    /* The additional oembed is pulled by Discord to enable improved embeds.
      Telegram does not use this. */
    let providerEngagementText = getSocialProof(status) ?? Strings.DEFAULT_AUTHOR_TEXT;
    providerEngagementText = providerEngagementText.replace(/ {4}/g, '  ');

    /* Workaround to prevent us from accidentally doubling up the engagement text in both provider and author fields */
    if (status.text.trim().length === 0) {
      providerEngagementText = Strings.DEFAULT_AUTHOR_TEXT;
    }

    let provider = '';
    const mediaType = overrideMedia ?? status.media.videos?.[0]?.type;

    let branding = Constants.BRANDING_NAME;
    if (c.req.url.includes('bsky')) {
      branding = Constants.BRANDING_NAME_BSKY;
    }

    if (mediaType === 'gif') {
      provider = i18next.t('gifIndicator', { brandingName: branding });
    } else if (
      status.embed_card === 'player' &&
      providerEngagementText !== Strings.DEFAULT_AUTHOR_TEXT
    ) {
      provider = providerEngagementText;
    }

    // Now you can use the 'provider' variable

    headers.push(
      `<link rel="alternate" href="{base}/owoembed?text={text}&status={status}&author={author}{provider}" type="application/json+oembed" title="{name}">`.format(
        {
          base: `https://${status.provider === DataProvider.Bsky ? Constants.STANDARD_BSKY_DOMAIN_LIST[0] : Constants.STANDARD_DOMAIN_LIST[0]}`,
          text: flags.gallery
            ? status.author.name
            : encodeURIComponent(truncateWithEllipsis(authorText, 255)),
          status: encodeURIComponent(statusId),
          author: encodeURIComponent(status.author.screen_name || ''),
          name: status.author.name || '',
          provider: provider ? `&provider=${encodeURIComponent(provider)}` : ''
        }
      )
    );
  }

  /* When dealing with a Tweet of unknown lang, fall back to en */
  const lang = status.lang === null ? 'en' : status.lang || 'en';

  /* Finally, after all that work we return the response HTML! */
  return c.html(
    Strings.BASE_HTML.format({
      lang: `lang="${lang}"`,
      headers: headers.join(''),
      body: ivbody
    }).replace(/>(\s+)</gm, '><')
  );
};
export { DataProvider };
