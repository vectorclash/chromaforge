import React from 'react';
import { useParams } from 'react-router-dom';

// Placeholder -- real product detail + mockup generator lands in the flow-porting phase.
export default function ProductPage() {
  const { productId } = useParams();
  return (
    <div>
      <h1 className="font-quicksand text-3xl font-bold">Product {productId}</h1>
      <p className="mt-2 text-neutral-500">Product detail coming soon.</p>
    </div>
  );
}
