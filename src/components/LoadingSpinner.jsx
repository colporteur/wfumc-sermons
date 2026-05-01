export default function LoadingSpinner({ label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-gray-500">
      <div className="h-10 w-10 rounded-full border-2 border-umc-300 border-t-umc-700 animate-spin" />
      <p className="mt-3 text-sm">{label}</p>
    </div>
  );
}
