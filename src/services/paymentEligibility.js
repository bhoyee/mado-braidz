// An owner may reserve a chair without collecting money. Its full known
// balance remains payable; a refund must not automatically invite repayment.
export function payableBalance(booking) {
  return (
    booking.paymentStatus === 'deposit_paid' ||
    (booking.paymentChoice === 'none' && booking.paymentStatus === 'unpaid')
  );
}
