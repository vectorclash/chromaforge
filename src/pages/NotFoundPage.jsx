import React from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import { usePageTitle } from '../hooks/usePageTitle';

export default function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <PageContainer title="Page not found" subtitle="Nothing's generated at this address.">
      <Button as={Link} to="/">
        Back to Chromaforge
      </Button>
    </PageContainer>
  );
}
