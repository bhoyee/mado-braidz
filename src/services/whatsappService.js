export function createWhatsAppService(config, send = fetch) {
  return {
    async sendOwnerAlert(notification) {
      const path = /^\/admin(?:\/|$)/.test(notification.url || '')
        ? notification.url
        : '/admin/notifications';
      if (config.WHATSAPP_PROVIDER === 'callmebot') {
        const url = new URL('https://api.callmebot.com/whatsapp.php');
        url.search = new URLSearchParams({
          phone: '+' + config.WHATSAPP_OWNER_NUMBER.replace(/\D/g, ''),
          apikey: config.CALLMEBOT_API_KEY,
          text: [
            'Mado African Braids',
            notification.title,
            notification.body || 'Open your owner portal for details.',
            config.APP_URL.replace(/\/$/, '') + path,
          ].join('\n'),
        }).toString();
        let response, body;
        try {
          response = await send(url.toString(), {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
          });
          body = await response.text();
        } catch {
          const error = new Error(
            'CallMeBot delivery needs verification before retrying.',
          );
          error.uncertain = true;
          throw error;
        }
        // Never store the provider body: it can echo the key, number and message.
        if (
          !response.ok ||
          /\b(?:error|invalid|not activated|not allowed)\b/i.test(body)
        )
          throw new Error(
            'CallMeBot rejected the owner alert. Check the activated number and API key.',
          );
        if (
          !/\bmessage\s+(?:successfully\s+)?(?:queued|sent)\b/i.test(
            body.replace(/<[^>]*>/g, ' '),
          )
        ) {
          const error = new Error(
            'CallMeBot acceptance needs verification before retrying.',
          );
          error.uncertain = true;
          throw error;
        }
        // CallMeBot supplies an acceptance response, not a delivery receipt ID.
        return 'callmebot:accepted';
      }
      let response;
      try {
        response = await send(
          `https://graph.facebook.com/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: config.WHATSAPP_OWNER_NUMBER.replace(/\D/g, ''),
              type: 'template',
              template: {
                name: config.WHATSAPP_TEMPLATE_NAME,
                language: { code: config.WHATSAPP_TEMPLATE_LANGUAGE },
                components: [
                  {
                    type: 'body',
                    parameters: [
                      notification.title,
                      notification.body || 'Open the owner portal for details.',
                      config.APP_URL.replace(/\/$/, '') + path,
                    ].map((text) => ({
                      type: 'text',
                      text: String(text)
                        .replace(/[\r\n\t]+/g, ' ')
                        .slice(0, 1000),
                    })),
                  },
                ],
              },
            }),
            signal: AbortSignal.timeout(15000),
          },
        );
      } catch {
        const error = new Error(
          'WhatsApp delivery needs verification before retrying.',
        );
        error.uncertain = true;
        throw error;
      }
      if (!response.ok)
        throw new Error(
          'WhatsApp provider rejected the alert (HTTP ' +
            response.status +
            ').',
        );
      let result;
      try {
        result = await response.json();
      } catch {
        /* Avoid duplicates when acceptance cannot be verified. */
      }
      if (!result?.messages?.[0]?.id) {
        const error = new Error(
          'WhatsApp acceptance needs verification before retrying.',
        );
        error.uncertain = true;
        throw error;
      }
      return result.messages[0].id;
    },
  };
}
