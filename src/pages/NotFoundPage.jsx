import React from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';

export default function NotFoundPage() {
  return (
    <PageContainer title="Page not found" subtitle="Nothing's generated at this address.">
      <Button as={Link} to="/">
        Back to ChromaForge
      </Button>
    </PageContainer>
  );
}
