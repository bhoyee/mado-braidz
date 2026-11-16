export const publicSettings = {
  // Owner-confirmed social profiles (footer icons). Facebook uses a search
  // link until the exact page address is confirmed.
  social: {
    instagram: 'https://www.instagram.com/madohairbraids/',
    tiktok: 'https://www.tiktok.com/@magdaline',
    facebook: 'https://www.facebook.com/search/top?q=Mado%20Braids',
    google: '',
  },
  hours: {
    summary: 'Open daily · 6:00 AM–6:00 PM',
    daysLabel: 'Open daily',
    timeLabel: '6:00 AM–6:00 PM',
    description:
      'Monday–Friday, 6:00 AM–6:00 PM. Saturday–Sunday, 6:00 AM–6:00 PM. Eastern time.',
    timezone: 'America/New_York',
    weekly: Object.fromEntries(
      [
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
      ].map((day) => [day, { open: '06:00', close: '18:00', closed: false }]),
    ),
  },
  policy: {
    rescheduleHours: 48,
    freeReschedules: 1,
    depositRefundable: false,
    hairIncluded: false,
  },
  seo: {
    pages: {
      home: {
        heading: 'Where beauty meets the art of braiding.',
        intro:
          'Beautiful, long-lasting braided styles that leave you feeling confident and effortlessly gorgeous.',
      },
      about: {
        heading: 'Where Beauty Meets the Art of Braiding',
        intro:
          'At Mado Braids, we believe braids are more than just a hairstyle—they are a form of self-expression, confidence, and beauty.',
        story:
          'We are passionate about creating beautiful, long-lasting braided styles that make every client feel confident and effortlessly gorgeous. From classic protective styles to trendy, customized looks, we pay close attention to detail to ensure every braid is neat, polished, and tailored to you.',
        values: [
          'Expert Braiding Techniques',
          'Comfortable, Long-Lasting Styles',
          'Warm, Welcoming Service',
          'A Blend of Modern & Traditional Looks',
        ],
      },
      faq: [
        {
          question: 'How does the deposit work?',
          answer:
            'Your deposit is applied toward your total, rather than added as a fee. The remaining balance is due at your appointment. Online checkout is coming soon; please call to arrange a booking.',
        },
        {
          question: 'Do I need to bring my own hair?',
          answer:
            'Yes. Please bring your braiding hair and call ahead to confirm the type and amount for your chosen style.',
        },
        {
          question: 'How should I arrive?',
          answer:
            'Please arrive with your hair washed and detangled, unless you have arranged the head wash add-on.',
        },
        {
          question: 'Can I reschedule?',
          answer:
            'The working policy allows one free reschedule at least 48 hours before your appointment. Deposits are non-refundable. Call the studio to make changes.',
        },
        {
          question: 'How long will I be in the chair?',
          answer:
            'Most styles reserve four hours. Your chosen style and any changes in length can affect the time; confirm with Mado before your visit.',
        },
      ],
    },
  },
};
