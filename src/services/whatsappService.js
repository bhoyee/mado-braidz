export function createWhatsAppService(config, send = fetch) {
  return {
    async sendOwnerAlert(notification) {
      const path = /^\/admin(?:\/|$)/.test(notification.url || '')
        ? notification.url
        : '/admin/notifications';
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
