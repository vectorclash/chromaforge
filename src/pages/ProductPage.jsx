import React from 'react';
import { useParams } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';

// Placeholder -- real product detail + mockup generator lands in the flow-porting phase.
export default function ProductPage() {
  const { productId } = useParams();
  return (
    <PageContainer title={`Product ${productId}`} subtitle="Product detail coming soon.">
      <p className="text-neutral-500">Variants, specs, and mockup preview will live here.</p>
    </PageContainer>
  );
}
