import './globals.css';

export const metadata = {
  title: 'ChefMind — RAG Recipe Recommendation Bot',
  description:
    'A retrieval-augmented recipe recommender built with Next.js, Express and Gemini.',
};

export const viewport = {
  themeColor: '#0b0d12',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
