import React from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import { usePageMeta } from '../hooks/usePageMeta';

export default function NotFoundPage() {
  usePageMeta({ title: 'Page not found', noindex: true });
  return (
    <PageContainer title="Page not found" subtitle="Nothing's generated at this address.">
      <Button as={Link} to="/">
        Back to Chromaforge
      </Button>
    </PageContainer>
  );
}
